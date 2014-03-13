# Firefox Puppeteer

This is a Firefox extension for remote-controlling the browser.  It
works in a highly specialized fashion that probably doesn't serve
anyone's needs but my own, but what the heck, I may as well publish
it.  It's derived from [MozRepl][], which you may find more useful.

**WORK IN PROGRESS:** This README is aspirational.  What's in the
repository right now might work but has not been tested thoroughly and
probably needs a bunch of sharp edges filed off.

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
the extension waits until Firefox is fully spun up---specifically,
until the ["final-ui-startup" observer notification][final-ui-startup]
fires, which is "just before the first window for the application is
displayed", i.e. any initial page load has not occurred.  (You
probably want to set the dedicated profile to come up on
`about:blank`.)  It then makes a loopback TCP connection to the port
number specified in the environment variable.  (There is no way to get
it to connect to a remote host; use SSH port forwarding or suchlike
instead.)  The server on the other end of the socket is expected to
speak the [ØMQ][zeromq] wire protocol; the extension interacts with it
as a [`ZMQ_REQ`-type client][zeromq:req].  (More specifically, the
extension implements [ZMTP/2.0][]; it will tolerate the "backward
interoperable" handshake variation described at the end of the
ZMTP/2.0 spec, but *not* a ZMTP/1 or /3 peer.)

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
  value will be evaluated as a new "control script", as described
  below.

* `quit`: No other properties are required.  The browser will exit.

## Control scripts

Control scripts are JavaScript, and execute in an environment which
you can think of as equivalent to an [add-on SDK local module][].
Specifically, they execute with "chrome" privileges, but with a
restricted global namespace as described on that page.  They can use
the global function `require()` to access many, but not all, of the
Add-on SDK's library modules (everything that is only useful for
defining user interfaces has been excluded).  The most important such
modules are [page-mod][] and [tabs][], which you will almost certainly
use to load Web pages.  You will probably also want to read the
[guide to content scripts][], as they are the only way to get at the
*contents* of a page once it has been loaded.

Like any other SDK module, there is an `exports` dictionary in the
global scope.  You must add a function named `initialize` to that
dictionary.  It will be called immediately after the script is
evaluated, with two arguments: a `deferred` object, and the dictionary
parsed from the original server-to-client message.  It is not expected
to return anything.  You can add other things to `exports` if you
want, but nothing will look at them (in particular, control scripts
are *not* able to `require` each other) so there is no point.

The `deferred` object has two properties, named `resolve` and
`reject`.  Your `initialize` function must arrange for one (but not
both) of these functions to get called eventually; this is what
triggers the next client-to-server message. `resolve` expects two
arguments: a "status" keyword to return to the server, and a
dictionary of additional properties to add to the client-to-server
message.  `reject` takes one argument, which should be an `Error`
instance, and always generates a message with `"status":"error"`.

The phrase "get called eventually" in the above is very important.
You are allowed to return from `initialize` without calling either of
the `deferred` functions, as long as something is going to do it,
well, eventually.  (There is an adjustable timeout, defaulting to one
minute, after which `reject` is called for you.)  Typically, this
would be an event handler of some sort.

The global scope also contains an object named `puppet`, which exposes
interfaces defined by the extension itself.  Currently there
are three of these:

 * `add_actions`: Takes one argument, a dictionary of new `action`
   values.  Henceforth, whenever the server sends down a message whose
   `action` field is one of the given values, the corresponding
   function will be called.  These functions have the same calling
   convention and expectations as `initialize`.

 * `remove_actions`: Takes one argument, a list of `action` values
   which should no longer be accepted.

 * `set_action_timeout`: Takes one argument, a number.  All
   *subsequent* action functions will be timed out after that many
   milliseconds.  (The currently-executing action function still gets
   the old timeout.)

## Possible future additions to the API

If it turns out to be more convenient that way...

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
[ZMTP/2.0]: http://rfc.zeromq.org/spec:15
[add-on SDK local module]: https://developer.mozilla.org/en-US/Add-ons/SDK/Guides/Module_structure_of_the_SDK#Local_Modules
[page-mod]: https://developer.mozilla.org/en-US/Add-ons/SDK/High-Level_APIs/page-mod
[tabs]: https://developer.mozilla.org/en-US/Add-ons/SDK/High-Level_APIs/tabs
[guide to content scripts]: https://developer.mozilla.org/en-US/Add-ons/SDK/Guides/Content_Scripts
[final-ui-startup]: https://developer.mozilla.org/en-US/docs/Observer_Notifications#Application_startup
