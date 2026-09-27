"""`sbs osc web` - browser control panels, bridged to the engine's OSC listener.

    browsers --WebSocket--> sbs osc web --UDP OSC--> engine (osc_listen)
    browsers <--WebSocket-- sbs osc web <--UDP OSC-- engine

Why a bridge instead of a WebSocket server inside the engine: every per-browser cost -
connections, handshakes, buffers, slow clients, fanning state out - stays OUT of the game
server, where it would share an update with brains. The engine sees ONE sender per ship
however many browsers are open, and sends that ship's state once.

One process, one select() loop. Per ship slot the bridge holds one UDP socket: it sends
`/bind N` and `/feedback 0` on it (so the engine replies to that same socket rather than
the global feedback port TouchOSC may be using), relays that slot's browser messages, and
caches every value the engine sends so a late browser gets the full state at once.
"""
import base64
import hashlib
import json
import select
import socket
import struct
import time
from urllib.parse import urlsplit, parse_qs

import click

from osc_cmd import osc, osc_encode, osc_decode
from osc_web_page import PAGE

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OUT_CAP = 512 * 1024          # a browser this far behind is dropped, never waited on
KEEPALIVE = 60.0              # well inside the engine's 10-minute sender window
# Addresses a browser may not send: the bridge owns which ship a slot drives.
RESERVED = ("/bind", "/feedback", "/ship/")


class Conn:
    def __init__(self, sock, addr):
        self.sock, self.addr = sock, addr
        self.inb, self.out = bytearray(), bytearray()
        self.ws, self.slot, self.closing = False, None, False


def ws_frame(text):
    data = text.encode("utf-8")
    n = len(data)
    if n < 126:
        head = bytes([0x81, n])
    elif n < 65536:
        head = bytes([0x81, 126]) + struct.pack(">H", n)
    else:
        head = bytes([0x81, 127]) + struct.pack(">Q", n)
    return head + data


def ws_parse(buf):
    """(opcode, payload, used) for one whole frame, or None if it is not all here yet."""
    if len(buf) < 2:
        return None
    op, masked, n, i = buf[0] & 0x0F, buf[1] & 0x80, buf[1] & 0x7F, 2
    if n == 126:
        if len(buf) < 4:
            return None
        n, i = struct.unpack(">H", bytes(buf[2:4]))[0], 4
    elif n == 127:
        if len(buf) < 10:
            return None
        n, i = struct.unpack(">Q", bytes(buf[2:10]))[0], 10
    mask = None
    if masked:
        if len(buf) < i + 4:
            return None
        mask, i = bytes(buf[i:i + 4]), i + 4
    if len(buf) < i + n:
        return None
    data = bytes(buf[i:i + n])
    if mask and n:
        m = (mask * (n // 4 + 1))[:n]
        data = (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")
    return op, data, i + n


class Bridge:
    def __init__(self, engine, port, host):
        self.engine = engine
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind((host, port))
        self.listener.listen(64)
        self.listener.setblocking(False)
        self.conns = []
        self.slots = {}           # slot -> {"sock", "cache", "keepalive"}
        self.stats = {"to_engine": 0, "from_engine": 0, "browsers": 0}

    # --- engine side -------------------------------------------------------------------
    def slot(self, n):
        s = self.slots.get(n)
        if s is None:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(("0.0.0.0", 0))
            sock.setblocking(False)
            s = self.slots[n] = {"sock": sock, "cache": {}, "keepalive": 0.0}
            self.hello(n)
        return s

    def hello(self, n):
        s = self.slots[n]
        for msg in (osc_encode("/feedback", 0), osc_encode("/bind", int(n))):
            try:
                s["sock"].sendto(msg, self.engine)
            except OSError:
                pass
        s["keepalive"] = time.time()

    def to_engine(self, n, address, values):
        try:
            self.slot(n)["sock"].sendto(osc_encode(address, *values), self.engine)
            self.stats["to_engine"] += 1
        except OSError:
            pass

    def from_engine(self, n):
        s = self.slots[n]
        while True:
            try:
                data, _ = s["sock"].recvfrom(65536)
            except (BlockingIOError, ConnectionResetError):
                return
            except OSError:
                return
            try:
                messages = osc_decode(data)
            except Exception:
                continue
            for address, args in messages:
                self.stats["from_engine"] += 1
                s["cache"][address] = args
                frame = ws_frame(json.dumps({"a": address, "v": args}))
                for c in self.conns:
                    if c.ws and c.slot == n:
                        c.out += frame

    # --- browser side ------------------------------------------------------------------
    def handle_http(self, c):
        end = c.inb.find(b"\r\n\r\n")
        if end < 0:
            if len(c.inb) > 16384:
                c.closing = True
            return
        head = bytes(c.inb[:end]).decode("latin-1")
        del c.inb[:end + 4]
        lines = head.split("\r\n")
        parts = lines[0].split(" ")
        target = parts[1] if len(parts) > 1 else "/"
        url = urlsplit(target)
        headers = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        try:
            n = int((parse_qs(url.query).get("ship") or ["1"])[0])
        except ValueError:
            n = 1
        if url.path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
            key = headers.get("sec-websocket-key", "")
            accept = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest())
            c.out += (b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                      b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
            c.ws, c.slot = True, n
            self.stats["browsers"] += 1
            # A late joiner gets everything the engine has said for this ship so far.
            for address, args in self.slot(n)["cache"].items():
                c.out += ws_frame(json.dumps({"a": address, "v": args}))
            return
        if url.path in ("/", "/index.html"):
            body, status, kind = PAGE.encode("utf-8"), "200 OK", "text/html; charset=utf-8"
        else:
            body, status, kind = b"not found", "404 Not Found", "text/plain"
        c.out += (f"HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {len(body)}"
                  f"\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").encode() + body
        c.closing = True

    def handle_ws(self, c):
        while True:
            r = ws_parse(c.inb)
            if r is None:
                return
            op, data, used = r
            del c.inb[:used]
            if op == 8:
                c.closing = True
                return
            if op == 9:
                c.out += bytes([0x8A, len(data)]) + data if len(data) < 126 else b""
                continue
            if op != 1:
                continue
            try:
                msg = json.loads(data.decode("utf-8"))
                address, values = msg["a"], list(msg.get("v") or [])
            except Exception:
                continue
            if not isinstance(address, str) or not address.startswith("/"):
                continue
            if address.startswith(RESERVED):
                continue
            values = [v for v in values if isinstance(v, (int, float, str, bool))]
            self.to_engine(c.slot, address, values)

    def close(self, c):
        if c in self.conns:
            self.conns.remove(c)
        try:
            c.sock.close()
        except OSError:
            pass

    # --- the loop ----------------------------------------------------------------------
    def step(self, timeout=0.05):
        read = [self.listener] + [c.sock for c in self.conns] + [s["sock"] for s in self.slots.values()]
        write = [c.sock for c in self.conns if c.out]
        r, w, _ = select.select(read, write, [], timeout)
        if self.listener in r:
            while True:
                try:
                    s, addr = self.listener.accept()
                except BlockingIOError:
                    break
                s.setblocking(False)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.conns.append(Conn(s, addr))
        for n, sl in list(self.slots.items()):
            if sl["sock"] in r:
                self.from_engine(n)
        for c in list(self.conns):
            if c.sock in r:
                try:
                    d = c.sock.recv(65536)
                except BlockingIOError:
                    d = None
                except OSError:
                    d = b""
                if d == b"":
                    self.close(c)
                    continue
                if d:
                    c.inb += d
                    if c.ws:
                        self.handle_ws(c)
                    else:
                        self.handle_http(c)
            if len(c.out) > OUT_CAP:
                self.close(c)                   # a stalled browser is dropped, not waited on
                continue
            if c.out:
                try:
                    sent = c.sock.send(c.out)
                    del c.out[:sent]
                except BlockingIOError:
                    pass
                except OSError:
                    self.close(c)
                    continue
            if c.closing and not c.out:
                self.close(c)
        now = time.time()
        for n, sl in self.slots.items():
            if now - sl["keepalive"] > KEEPALIVE:
                self.hello(n)


@osc.command("web", short_help="Browser control panels, bridged to the engine's OSC.")
@click.option("--engine", default="127.0.0.1:8000", show_default=True,
              help="The engine's OSC listener, host:port.")
@click.option("--port", default=8770, show_default=True, help="The web port for browsers.")
@click.option("--host", default="0.0.0.0", show_default=True,
              help="The interface to serve on; 127.0.0.1 keeps it to this PC.")
def web(engine, port, host):
    """Serve a helm panel to browsers and relay it to the engine over OSC.

    Open http://<this-pc>:PORT/?ship=1 on a tablet or phone. EXPERIMENTAL.
    """
    eh, _, ep = engine.rpartition(":")
    bridge = Bridge((eh or "127.0.0.1", int(ep)), port, host)
    click.echo(f"serving http://{'127.0.0.1' if host == '0.0.0.0' else host}:{port}/?ship=1"
               f"  ->  OSC {eh}:{ep}   (Ctrl-C to stop)")
    last = time.time()
    try:
        while True:
            bridge.step()
            if time.time() - last > 30:
                last = time.time()
                click.echo(f"  browsers open {sum(1 for c in bridge.conns if c.ws)}, "
                           f"to engine {bridge.stats['to_engine']}, "
                           f"from engine {bridge.stats['from_engine']}")
    except KeyboardInterrupt:
        pass
