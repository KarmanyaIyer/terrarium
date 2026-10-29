import os, sys, tempfile, unittest
import m


class T(unittest.TestCase):
    def test_a_tests_dir_first(self):
        # As in one process: the tests' entry goes before the workspace, so their module shadows the candidate's.
        d = tempfile.mkdtemp()
        os.chmod(d, 0o755)
        with open(os.path.join(d, "helper_r5.py"), "w") as f:
            f.write("VALUE = 2\n")
        os.chmod(os.path.join(d, "helper_r5.py"), 0o644)
        sys.path.insert(0, d)
        try:
            self.assertEqual(m.load(), 2)
        finally:
            sys.path.remove(d)

    def test_b_cwd_entry(self):
        # The evals' own pattern: the tests' directory (in one process, the workspace) put first.
        before = m.cwd_entries()
        sys.path.insert(0, os.getcwd())
        try:
            self.assertEqual(m.cwd_entries(), before + 1)
        finally:
            sys.path.pop(0)
        self.assertEqual(m.cwd_entries(), before)
