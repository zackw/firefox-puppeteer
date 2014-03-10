#! /usr/bin/python3

# Interactive test REPL for the puppeteer.
# Must be run from the top level of the add-on directory, with
# the SDK activated, or it won't do anything useful.

import os
import os.path
import pprint
import readline
import subprocess
import sys
import zmq

def main():
    ctx = zmq.Context()
    sock = ctx.socket(zmq.REP)
    port = sock.bind_to_random_port(addr="tcp://127.0.0.1")

    env = os.environ.copy()
    env["PUPPETEER_SOCKET"]    = str(port)
    env["PUPPETEER_CLIENT_ID"] = sys.argv[1] if len(sys.argv) >= 2 else ""
    env["PUPPETEER_LOG"]       = os.path.join(os.getcwd(),
                                              "puppeteer-client-log.txt")

    ffx = subprocess.Popen(["gnome-terminal", "-x", "cfx", "run"],
                           stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL,
                           env=env)

    while True:
        msg = sock.recv_json()
        pprint.pprint(msg)
        resp = { "client_id": msg["client_id"],
                 "sequence": msg["sequence"] }
        while True:
            line = input("--> ")
            if not line:
                break
            k, _, v = line.partition(":")
            resp[k] = v
        sock.send_json(resp)

main()
