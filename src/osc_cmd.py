"""`sbs osc` - tools for the engine's OSC listener (sbs_utils `procedural/osc.py`).

The listener itself runs INSIDE the engine (`osc_listen(8000)` from MAST). These are the
host-side tools around it: send a message the way a tablet would, and watch what the
engine sends back.

    sbs osc send /helm/throttle 0.5
    sbs osc send /weapons/fire/Homing 1 --host 192.168.1.20
    sbs osc monitor                    # prints /state/... as it arrives on port 9000

The codec is a copy of the library's on purpose: sbs_cli never imports sbs_utils.
"""
import socket
import struct
import time

import click

from cli_cmd import cli


def _pad(n):
    return (4 - n % 4) % 4


def _osc_str(s):
    b = str(s).encode("utf-8") + b"\0"
    return b + b"\0" * _pad(len(b))


def _read_str(data, i):
    end = data.index(b"\0", i)
    n = end - i + 1
    return data[i:end].decode("utf-8"), i + n + _pad(n)


def osc_encode(address, *args):
    tags, payload = ",", b""
    for a in args:
        if a is True:
            tags += "T"
        elif a is False:
            tags += "F"
        elif isinstance(a, int):
            tags += "i"
            payload += struct.pack(">i", a)
        elif isinstance(a, float):
            tags += "f"
            payload += struct.pack(">f", a)
        else:
            tags += "s"
            payload += _osc_str(a)
    return _osc_str(address) + _osc_str(tags) + payload


def osc_decode(data):
    """[(address, [args])] for one packet, bundles flattened."""
    if data[:8] == b"#bundle\0":
        out, i = [], 16
        while i < len(data):
            size = struct.unpack(">i", data[i:i + 4])[0]
            out.extend(osc_decode(data[i + 4:i + 4 + size]))
            i += 4 + size
        return out
    address, i = _read_str(data, 0)
    if i >= len(data):
        return [(address, [])]
    tags, i = _read_str(data, i)
    args = []
    for t in tags[1:]:
        if t == "i":
            args.append(struct.unpack(">i", data[i:i + 4])[0]); i += 4
        elif t == "f":
            args.append(round(struct.unpack(">f", data[i:i + 4])[0], 4)); i += 4
        elif t == "s":
            s, i = _read_str(data, i); args.append(s)
        elif t in "TF":
            args.append(t == "T")
        elif t == "N":
            args.append(None)
    return [(address, args)]


def _parse_arg(text, as_string):
    """A command-line argument as an OSC value: int, then float, else a string."""
    if as_string:
        return text
    for kind in (int, float):
        try:
            return kind(text)
        except ValueError:
            pass
    return text


@cli.group("osc", short_help="Send to, and listen to, the engine's OSC listener.")
def osc():
    """Tools for the in-engine OSC listener (TouchOSC tablets).

    The engine listens once a mission calls osc_listen(port) - in LegendaryMissions,
    set OSC: enable: true in the settings.
    """


@osc.command("send", short_help="Send one OSC message, as a tablet would.")
@click.argument("address")
@click.argument("values", nargs=-1)
@click.option("--host", default="127.0.0.1", show_default=True, help="The engine's machine.")
@click.option("--port", default=8000, show_default=True, help="The engine's OSC port.")
@click.option("--string", "as_string", is_flag=True, help="Send every value as a string.")
@click.option("--float", "as_float", is_flag=True,
              help="Send numbers as floats, the way TouchOSC faders and buttons do.")
def send(address, values, host, port, as_string, as_float):
    """Send ADDRESS with VALUES, e.g. `sbs osc send /helm/throttle 0.5`."""
    if not address.startswith("/"):
        raise click.BadParameter("an OSC address starts with /", param_hint="ADDRESS")
    args = [_parse_arg(v, as_string) for v in values]
    if as_float:
        args = [float(a) if isinstance(a, int) else a for a in args]
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.sendto(osc_encode(address, *args), (host, port))
    sock.close()
    click.echo(f"sent {address} {' '.join(repr(a) for a in args)} -> {host}:{port}")


@osc.command("monitor", short_help="Print the state the engine sends back.")
@click.option("--port", default=9000, show_default=True,
              help="The feedback port given to osc_listen.")
@click.option("--changes/--all", default=True, show_default=True,
              help="Print only values that changed.")
@click.option("--filter", "prefix", default="", help="Only addresses starting with this.")
@click.option("--seconds", default=0.0, help="Stop after this long (0 runs until Ctrl-C).")
def monitor(port, changes, prefix, seconds):
    """Listen on PORT and print each OSC message the engine sends.

    The engine only sends to tablets it has HEARD from in the last 30 seconds, so send
    something first (from this machine, e.g. `sbs osc send /bind 1`) or nothing arrives.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind(("0.0.0.0", port))
    except OSError as e:
        raise click.ClickException(f"cannot listen on port {port}: {e}")
    sock.settimeout(0.5)
    click.echo(f"listening on port {port} - Ctrl-C to stop")
    last = {}
    end = time.time() + seconds if seconds else None
    try:
        while end is None or time.time() < end:
            try:
                data, addr = sock.recvfrom(65536)
            except (socket.timeout, TimeoutError):
                continue
            try:
                messages = osc_decode(data)
            except Exception as e:
                click.echo(f"  (malformed packet from {addr[0]}: {e})")
                continue
            for address, args in messages:
                if prefix and not address.startswith(prefix):
                    continue
                if changes and last.get(address) == args:
                    continue
                last[address] = args
                shown = " ".join(str(a) for a in args)
                click.echo(f"{time.strftime('%H:%M:%S')}  {address:32s} {shown}")
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
