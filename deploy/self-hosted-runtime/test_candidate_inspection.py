import unittest
from inspect_candidates import describe


class InspectionTests(unittest.TestCase):
    def test_embedded_identifier_is_explained_without_path_exemption(self):
        result = describe(b"mask-" + b"identifier" * 4, "provider_key", [])
        self.assertTrue(result)
        self.assertTrue(all(row["verdict"] == "false_positive" for row in result))

    def test_standalone_provider_key_requires_review(self):
        result = describe(b"key='sk-" + b"x" * 32 + b"'", "provider_key", [])
        self.assertEqual(result[0]["verdict"], "review_required")
        self.assertNotIn("x" * 32, result[0]["context"])

    def test_pem_marker_is_not_key_material(self):
        result = describe(b'format = "-----BEGIN PRIVATE KEY-----";', "private_key", [])
        self.assertEqual(result[0]["verdict"], "false_positive")

    def test_complete_pem_remains_for_review(self):
        value = b"-----BEGIN PRIVATE KEY-----\n" + b"A" * 128 + b"\n-----END PRIVATE KEY-----"
        result = describe(value, "private_key", [])
        self.assertEqual(result[0]["verdict"], "review_required")

    def test_known_private_value_is_never_dismissed(self):
        value = "sk-" + "a" * 40
        result = describe(value.encode(), "provider_key", [value])
        self.assertEqual(result[0]["verdict"], "secret")
        self.assertNotIn(value, result[0]["context"])


if __name__ == "__main__":
    unittest.main()
