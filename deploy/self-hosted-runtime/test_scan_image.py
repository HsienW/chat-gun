"""以合成 Docker archive 驗證掃描邊界，不需要 Docker daemon。"""
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from scan_image import scan_archive


def tar_bytes(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


class ImageScanTests(unittest.TestCase):
    def scan(self, layers, env=None, known=None):
        files = {
            "manifest.json": json.dumps([{
                "Config": "config.json",
                "Layers": [f"{index}/layer.tar" for index in range(len(layers))],
            }]).encode(),
            "config.json": json.dumps({"config": {"Env": env or []}}).encode(),
        }
        for index, layer in enumerate(layers):
            files[f"{index}/layer.tar"] = tar_bytes(layer)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "image.tar"
            path.write_bytes(tar_bytes(files))
            return scan_archive(path, known or [])

    def test_clean_archive_has_layer_and_file_counts(self):
        result = self.scan([{"app/index.js": b"const port = process.env.PORT;"}])
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["layersScanned"], 1)
        self.assertEqual(result["filesScanned"], 1)

    def test_deleted_secret_is_still_reported_from_earlier_layer(self):
        result = self.scan([{"app/.env": b"setting=value"}, {"app/.wh..env": b""}])
        self.assertEqual(result["status"], "fail")
        self.assertTrue(any(item["rule"] == "environment_file" for item in result["findings"]))

    def test_known_secret_crossing_read_boundary_is_detected_and_redacted(self):
        value = "fixture-" + "x" * 40
        content = b"a" * (65536 - 8) + value.encode() + b"z"
        result = self.scan([{"app/config.txt": content}], known=[value])
        self.assertEqual(result["status"], "fail")
        self.assertNotIn(value, json.dumps(result))
        self.assertTrue(any(item["rule"] == "known_secret" for item in result["findings"]))

    def test_nonempty_secret_in_image_environment_is_rejected(self):
        result = self.scan([], env=["API_KEY=fixture-value"])
        self.assertEqual(result["status"], "fail")
        self.assertNotIn("fixture-value", json.dumps(result))

    def test_provider_key_pattern_is_detected(self):
        value = b"sk-" + b"1" * 36
        result = self.scan([{"app/config.js": value}])
        self.assertEqual(result["status"], "fail")
        self.assertNotIn(value.decode(), json.dumps(result))

    def test_unreadable_archive_fails_instead_of_passing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.tar"
            path.write_bytes(b"invalid")
            with self.assertRaises(tarfile.ReadError):
                scan_archive(path, [])


if __name__ == "__main__":
    unittest.main()
