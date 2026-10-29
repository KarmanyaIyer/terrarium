"""Candidate side of a grading run (uid 1000 in the guest). Imports the candidate's modules from the
workspace copy and answers the test process over the socket on --fd. Untrusted by design: everything it
reports is checked on the test side."""

import os
import socket
import sys


def main():
    args = sys.argv[1:]
    fd = int(args[args.index("--fd") + 1])
    workspace = args[args.index("--workspace") + 1]
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    from grade_rpc import TEST_ARGV, Server

    sys.path.remove(here)
    sys.argv = list(TEST_ARGV)  # as the tests' side and the plain run have it
    sys.path.insert(0, workspace)
    os.chdir(workspace)
    sock = socket.socket(fileno=fd)
    Server(sock).serve_forever()


if __name__ == "__main__":
    main()
