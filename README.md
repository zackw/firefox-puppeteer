# Firefox Puppeteer

This is a Firefox extension for remote-controlling the browser.  It
works in a highly specialized fashion that probably doesn't serve
anyone's needs but my own, but what the heck, I may as well publish
it.  It's derived from [MozRepl][], which you may find more useful.

**WORK IN PROGRESS:** This README is aspirational.  What's in the
repository right now is a carbon copy of MozRepl with some
definitely-unnecessary bits deleted.  Tune in next week (I hope) for
something that works.

**SECURITY ADVISORY:** This extension places complete trust in code
coming over a control socket.  That code is executed in privileged
("chrome") context, and can do anything an extension can do.  Don't
install this extension in a normal browsing profile, and don't connect
it to a server process you didn't write.

## What it does

This extension has no in-browser user interface.  You are expected to
stick the `.xpi` file in a dedicated Firefox profile and then start
the browser with a command line of the form

    PUPPETEER_SOCKET=NNNN .../path/to/firefox -profile .../path/to/profile

where `NNNN` is a port number.  If you don't start the browser with
the `PUPPETEER_SOCKET` environment variable set, the extension does
nothing.  You may additionally set the `PUPPETEER_LOG` environment
variable to an absolute pathname; if you do, everything sent or
received on the control socket (see below) will be logged to that
file.  (Environment variables are used instead of command line options
because the [Add-on SDK][] currently doesn't support command line
options.)

When started with a `PUPPETEER_SOCKET` declared in the environment,
the extension waits until Firefox is fully spun up (specifically,
until the first time a tab reports it is fully loaded; you probably
want to set the default homepage in the dedicated profile to be
`about:blank` to expedite this).  It then makes a loopback TCP
connection to the port number specified in the environment variable.
(There is no way to get it to connect to a remote host; use SSH port
forwarding or suchlike instead.)  The server on the other end of the
socket is expected to speak the [ØMQ][zeromq] wire protocol; the
extension interacts with it as a [`ZMQ_REQ`-type client][zeromq:req].

Upon connection, the server supplies a JavaScript program which
defines what the puppeted browser actually *does*, using the client
API described below.

## The control protocol

All messages on the wire (after stripping the ØMQ framing) are
JavaScript objects, JSON-formatted and UTF-8-coded.  All
client-generated messages have the general format

    { "client_id": string,
      "sequence":  non-negative integer,
      "status":    string,
      ... }

`client_id` is a value identifying the client; it is initially `""`
but your code can set it to whatever you like.  Do not confuse this
with the ØMQ "identity", which is made up on the *server* side.

`sequence` starts with zero and increments by one for each
client-to-server message.  It's probably unnecessary given that
`ZMQ_REQ` sockets are strictly query-response, but leaving out
sequence numbers in wire protocols is a well-known source of
heartache.

`status` is whatever you want it to be, but there are two predefined
value: the very first message sent from client to server will always
be `"status":"hello"`, and if the server ever sends an ill-formed
message (including a message with an unregistered `action`, see
below), you will get an immediate `"status":"error"` message followed
by a disconnect.

Your code may add as many additional properties to the message as you
like.

Server-to-client messages have the general format

    { "client_id": string,
      "sequence": non-negative integer,
      "action": string,
      ... }

The `client_id` and `sequence` properties must echo the values sent in
the previous client-to-server message; this is for debugging.  Like
`status`, `action` can be whatever you want it to be, but there are
two predefined values:

* `script`: The object must also contain a `script` property.  Its
  value will be executed as JavaScript in a special chrome-privileged
  sandbox that exposes the API defined below.  This script MUST, as a
  side effect, cause another client-to-server message to be generated,
  using that API; otherwise, the extension will stop doing anything
  useful and the connection will go idle forever.

* `quit`: No other properties are required.  The browser will exit.

## The client-side API

is still to-be-defined, but here are things I know need to be possible:

* registering new actions
* synchronously completing work and sending a message to the server
* promising to transmit an async message to the server later
* registering interest in page/tab/window events
* requesting page loads
* manipulating content DOM
* firing XHR queries

## Licensing

Copyright 2014 Zack Weinberg.

Based on MozRepl, copyright 2006-2014 Ethan, Étienne Deparis, Ian
Shannon, Luca Greco, Massimiliano Mirra, and other contributors.

Based on zmqsocket-js and zmqsocket-as, copyright 2011 Artur Brugeman
and other contributors.

Firefox Puppeteer is free software: you can redistribute it and/or
modify it under the terms of the GNU General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.

[MozRepl]: https://github.com/bard/mozrepl/wiki
[Add-on SDK]: https://developer.mozilla.org/en-US/Add-ons/SDK
[zeromq]: http://zeromq.org/
[zeromq:req]: http://api.zeromq.org/3-2:zmq-socket#toc3
