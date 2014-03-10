#! /usr/bin/python3

# Interactive test REPL for the puppeteer.
# Must be run from the top level of the add-on directory, with
# the SDK activated, or it won't do anything useful.

import os
import os.path
import pprint
import readline
import sys
import zmq

def main():
    ctx = zmq.Context()
    sock = ctx.socket(zmq.REP)
    port = sock.bind_to_random_port(addr="tcp://127.0.0.1")

    sys.stdout.write("PUPPETEER_SOCKET={}\n".format(port))

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
