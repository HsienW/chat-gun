import unittest
from inspect_candidates import describe


class PemEvidenceTests(unittest.TestCase):
    def test_complete_key_material_is_not_written_to_context(self):
        material = b"Q" * 128
        value = b"-----BEGIN PRIVATE KEY-----\n" + material + b"\n-----END PRIVATE KEY-----"
        row = describe(value, "private_key", [])[0]
        self.assertNotIn(material.decode(), row["context"])

    def test_partial_key_material_requires_review_and_is_not_printed(self):
        material = b"R" * 128
        value = b"-----BEGIN PRIVATE KEY-----\n" + material
        row = describe(value, "private_key", [])[0]
        self.assertEqual(row["verdict"], "review_required")
        self.assertNotIn(material.decode(), row["context"])


if __name__ == "__main__":
    unittest.main()
