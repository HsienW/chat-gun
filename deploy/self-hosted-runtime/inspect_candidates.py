"""逐筆重現既有掃描命中；輸出雜湊與遮蔽上下文，不輸出憑證。"""
import hashlib
import ast
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from scan_image import RULES

SOURCE_URL = "https://raw.githubusercontent.com/gnutls/gnutls/3.7.9/lib/crypto-selftests-pk.c"
PUBLIC_VECTORS = {}
# 每個指紋均由命中內容與相鄰語法人工判讀；不依檔名或路徑豁免。
REVIEWED_ASSIGNMENTS = {
    "83de2ee65a02a87c53dee6f8c1593524d595f9d70024c86cb1f1c08400615f41": "環境變數名稱常數的右值與左值同名，並非環境變數內容。",
    "69c07c2a9d479e6084f41099c4e3477b3421b3e455719c8f59c7fc57f252ef22": "OpenTelemetry attribute 的 remove_authentication_token enum 宣告；值是事件名稱。",
    "ad28f167aae5a294462d638865896789f47396a200d092155070213efff64221": "OpenTelemetry attribute 的 set_authentication_token enum 宣告；值是事件名稱。",
    "d229d9f66a071ba4379c17fb2767974024776266eb1ad3da44e1877f81181bd9": "OpenTelemetry attribute 的 remove_authentication_token enum 常數；值是事件名稱。",
    "703cf964a9a5c6863de59f956abd885d37e9e4abcb7a4fd0119b81472eaab1a7": "OpenTelemetry attribute 的 set_authentication_token enum 常數；值是事件名稱。",
    "a4c53374fe57d579c2b3f20bd5b31afd706fe4dc73881fdb71ce3fae4fdaa0c7": "generated SDK 的 @example 固定 UUID，與同範例的 run ID 相同；是文件 fixture。",
    "ef74ed30161110fe1eeae374652c175af126495c5aba6904625a24a85adbdf5b": "初始化的 refresh_token placeholder；相鄰註解明示第一次 API 呼叫前必須刷新。",
    "852229342cc105da57b59eb93f5f33654bedd1ef21ccdad29f96924ff2544542": "README 範例密碼；base64 解碼為 not my real password，並非部署憑證。",
}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def load_public_vectors():
    # 只在記憶體解析官方公開來源；不保存或輸出 PEM 材料，不執行來源。
    with urllib.request.urlopen(SOURCE_URL, timeout=60) as response:
        source = response.read()
    if b"gnutls_pk_self_test" not in source or b"PK_KNOWN_TEST" not in source:
        raise ValueError("unexpected_public_source")
    pattern = rb'static const char (\w+)\[\]\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*)+);'
    for match in re.finditer(pattern, source):
        symbol = match[1].decode()
        if not symbol.endswith("_privkey"):
            continue
        value = "".join(ast.literal_eval(token.decode()) for token in re.findall(rb'"(?:[^"\\]|\\.)*"', match[2])).encode()
        if b"PRIVATE KEY-----" in value and source.count(match[1]) > 1:
            PUBLIC_VECTORS[sha(value.strip())] = {"url": SOURCE_URL, "sourceSha256": sha(source), "symbol": symbol,
                "reason": "完整 PEM 指紋與官方 gnutls_pk_self_test 的公開 known-answer 測試向量相同；不是本次部署注入的私有憑證。"}
    if not PUBLIC_VECTORS:
        raise ValueError("public_vectors_not_found")
    return {"url": SOURCE_URL, "sha256": sha(source), "vectorCount": len(PUBLIC_VECTORS)}


def describe(data, rule, secrets):
    occurrences = []
    for match in RULES[rule].finditer(data):
        start, end = match.span()
        before = data[max(0, start-160):start]
        after = data[end:end+160]
        fragment = data[max(0, start-160):min(len(data), end+160)]
        for pattern in RULES.values():
            fragment = pattern.sub(b"[CANDIDATE]", fragment)
        for secret in secrets:
            fragment = fragment.replace(secret.encode(), b"[PRIVATE_VALUE]")
        fragment = re.sub(rb"[\x00-\x08\x0b-\x1f]", b".", fragment)
        embedded = start > 0 and bool(re.fullmatch(rb"[A-Za-z0-9_]", data[start-1:start]))
        pem = re.match(rb"\s*[A-Za-z0-9+/=\r\n]{40,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", data[end:end+32768]) if rule == "private_key" else None
        complete_pem = bool(pem)
        body_prefix = rule == "private_key" and bool(re.match(rb"[\r\n ]+[A-Za-z0-9+/=]{16,}", data[end:end+128]))
        public_vector = None
        pem_sha = None
        if rule == "private_key":
            fragment = "PEM 上下文不輸出；僅保存位置、指紋與判讀依據。".encode()
            if pem:
                pem_sha = sha(data[start:end+pem.end()].strip())
                public_vector = PUBLIC_VECTORS.get(pem_sha)
        known = any(secret.encode() in match.group() for secret in secrets)
        verdict = "review_required"
        reason = "需要判讀完整語法上下文。"
        if known:
            verdict, reason = "secret", "命中本次提供的已知私有值。"
        elif public_vector:
            verdict, reason = "false_positive", public_vector["reason"]
        elif rule == "private_key" and not complete_pem and not body_prefix:
            verdict, reason = "false_positive", "PEM 標頭後直接為字串結尾或非 base64 符號；是格式標記，沒有私鑰正文。"
        elif rule == "credential_assignment" and sha(match.group()) in REVIEWED_ASSIGNMENTS:
            verdict, reason = "false_positive", REVIEWED_ASSIGNMENTS[sha(match.group())]
        elif rule == "provider_key" and embedded:
            verdict, reason = "false_positive", "命中起點前為識別字字元，sk-/其他前綴只是較長識別字的一部分，不是獨立金鑰。"
        occurrences.append({"offset": start, "length": end-start, "matchSha256": sha(match.group()), "context": fragment.decode("utf8", "replace"),
                            "embeddedIdentifier": embedded, "completePem": complete_pem, "pemSha256": pem_sha,
                            "publicVector": public_vector, "verdict": verdict, "reason": reason})
    return occurrences


def inspect(image, expected, secrets):
    handle, filename = tempfile.mkstemp(prefix="chat-gun-spike-judgement-", suffix=".tar")
    os.close(handle)
    try:
        subprocess.run(["docker", "image", "save", "--output", filename, "--", image], check=True, capture_output=True, timeout=300)
        rows = []
        wanted = {(item["layer"], item["path"], item["rule"]): item for item in expected}
        with tarfile.open(filename, "r:*") as archive:
            manifest = json.load(archive.extractfile("manifest.json"))[0]
            for index, layer_path in enumerate(manifest["Layers"]):
                paths = {p for layer, p, rule in wanted if layer == index}
                if not paths:
                    continue
                with archive.extractfile(layer_path) as layer_file:
                    with tarfile.open(fileobj=layer_file, mode="r|*") as layer:
                        for member in layer:
                            if not member.isfile() or member.name not in paths:
                                continue
                            data = layer.extractfile(member).read()
                            for key in wanted:
                                if key[:2] != (index, member.name):
                                    continue
                                occurrences = describe(data, key[2], secrets)
                                if not occurrences:
                                    raise ValueError("prior_candidate_not_reproduced")
                                verdict = "false_positive" if all(o["verdict"] == "false_positive" for o in occurrences) else "review_required"
                                rows.append({"image": image, "layer": index, "layerArchive": layer_path, "path": member.name, "rule": key[2],
                                             "fileSha256": sha(data), "sizeBytes": len(data), "verdict": verdict, "occurrences": occurrences})
        if len(rows) != len(expected):
            raise ValueError("candidate_coverage_incomplete")
        return {"image": image, "expectedCount": len(expected), "reproducedCount": len(rows), "rows": rows}
    finally:
        Path(filename).unlink(missing_ok=True)


if __name__ == "__main__":
    supplied = json.load(sys.stdin)
    load_public_vectors()
    evidence = json.loads(Path(supplied["evidencePath"]).read_text(encoding="utf8"))
    output = {name: inspect(scan["image"], scan["findings"], supplied["secrets"]) for name, scan in evidence["imageScans"].items()}
    print(json.dumps(output, ensure_ascii=True))
