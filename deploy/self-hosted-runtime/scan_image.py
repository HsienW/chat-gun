"""掃描 docker save 的每一層；只輸出位置與規則，不輸出匹配值。"""
import argparse
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

RULES = {
    "provider_key": re.compile(rb"(?:sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})"),
    "private_key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "credential_assignment": re.compile(rb"(?i)(?:api[_-]?key|password|secret|token)\s*[=:]\s*[\x22\x27][A-Za-z0-9_+/\-=]{24,}[\x22\x27]"),
}
SENSITIVE_ENV = re.compile(r"(?i)(?:api[_-]?key|password|secret|token|credential)")


def scan_archive(path, known_secrets):
    secrets = [value.encode() for value in known_secrets if isinstance(value, str) and len(value) >= 8]
    overlap = max([4096, *(len(value) for value in secrets)])
    findings = []
    files_scanned = 0

    def inspect(stream, layer, name):
        matched = set()
        tail = b""
        while chunk := stream.read(65536):
            block = tail + chunk
            matched.update(rule for rule, pattern in RULES.items() if pattern.search(block))
            if any(value in block for value in secrets):
                matched.add("known_secret")
            tail = block[-overlap:]
        for rule in sorted(matched):
            findings.append({"layer": layer, "path": name, "rule": rule})

    with tarfile.open(path, "r:*") as archive:
        manifests = json.load(archive.extractfile("manifest.json"))
        if not isinstance(manifests, list) or len(manifests) != 1:
            raise ValueError("expected_one_image")
        manifest = manifests[0]
        config = json.load(archive.extractfile(manifest["Config"]))
        for entry in config.get("config", {}).get("Env", []) or []:
            name, separator, value = entry.partition("=")
            if separator and value and SENSITIVE_ENV.search(name):
                findings.append({"layer": "config", "path": name, "rule": "secret_environment"})
        with archive.extractfile(manifest["Config"]) as stream:
            inspect(stream, "config", manifest["Config"])
        for index, layer_path in enumerate(manifest["Layers"]):
            with archive.extractfile(layer_path) as layer_file:
                with tarfile.open(fileobj=layer_file, mode="r|*") as layer:
                    for member in layer:
                        if not member.isfile():
                            continue
                        files_scanned += 1
                        name = Path(member.name).name
                        if name == ".env" or name.startswith(".env."):
                            findings.append({"layer": index, "path": member.name, "rule": "environment_file"})
                        with layer.extractfile(member) as stream:
                            inspect(stream, index, member.name)
    return {
        "status": "fail" if findings else "pass",
        "layersScanned": len(manifest["Layers"]),
        "filesScanned": files_scanned,
        "findings": findings,
        "limitations": "啟發式規則與選用的已知值比對；不構成不存在任何 secret 的數學證明。",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--known-secrets-stdin", action="store_true")
    args = parser.parse_args()
    known = json.load(sys.stdin) if args.known_secrets_stdin else []
    if not isinstance(known, list) or not all(isinstance(value, str) for value in known):
        raise ValueError("invalid_secret_list")
    descriptor, filename = tempfile.mkstemp(prefix="chat-gun-spike-image-", suffix=".tar")
    os.close(descriptor)
    try:
        subprocess.run(
            ["docker", "image", "save", "--output", filename, "--", args.image],
            check=True, capture_output=True, timeout=300,
        )
        result = scan_archive(filename, known)
        print(json.dumps({"image": args.image, **result}, ensure_ascii=False))
        return 0 if result["status"] == "pass" else 1
    finally:
        Path(filename).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({"status": "error", "error": type(error).__name__}))
        sys.exit(2)
