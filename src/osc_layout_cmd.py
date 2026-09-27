"""`sbs osc layout` - write a TouchOSC panel (.tosc) for one of the five consoles.

A .tosc file is the TouchOSC (2020+) document: XML, zlib-compressed. This is written from
the format as known, NOT from a spec in hand - so `--xml` writes the plain XML beside it
for when a layout does not open, and each layout wants opening once in the TouchOSC editor
before anyone relies on it.

Every control is bound to the SAME address both ways: it sends when touched and follows
what the engine sends back, which is how the throttle fader moves when somebody moves the
real helm throttle. Gauges are faders that only receive.
"""
import os
import uuid
import zlib
from xml.sax.saxutils import escape

import click

from osc_cmd import osc


def _prop(kind, key, value):
    if kind == "r":
        x, y, w, h = value
        v = f"<x>{x}</x><y>{y}</y><w>{w}</w><h>{h}</h>"
    elif kind == "c":
        r, g, b, a = value
        v = f"<r>{r}</r><g>{g}</g><b>{b}</b><a>{a}</a>"
    elif kind == "s":
        v = f"<![CDATA[{value}]]>"
    else:
        v = str(value)
    return f"<property type='{kind}'><key><![CDATA[{key}]]></key><value>{v}</value></property>"


def _partial(kind, conversion, value, lo=0, hi=1):
    return (f"<partial><type>{kind}</type><conversion>{conversion}</conversion>"
            f"<value><![CDATA[{value}]]></value><scaleMin>{lo}</scaleMin>"
            f"<scaleMax>{hi}</scaleMax></partial>")


def _osc_message(address, lo=0, hi=1, send=True, receive=True):
    return ("<osc><enabled>1</enabled>"
            f"<send>{1 if send else 0}</send><receive>{1 if receive else 0}</receive>"
            "<feedback>0</feedback><connections>11111</connections>"
            "<triggers><trigger><var><![CDATA[x]]></var><condition>ANY</condition></trigger></triggers>"
            f"<path>{_partial('CONSTANT', 'STRING', address)}</path>"
            f"<arguments>{_partial('VALUE', 'FLOAT', 'x', lo, hi)}</arguments></osc>")


def _value(key, default):
    """A control VALUE (not a property). A label's text is one: set as a property it is
    ignored and the label reads "Label" - which is what the first helm.tosc showed."""
    return (f"<value><key><![CDATA[{key}]]></key><locked>0</locked>"
            f"<lockedDefaultCurrent>0</lockedDefaultCurrent>"
            f"<default><![CDATA[{default}]]></default><defaultPull>0</defaultPull></value>")


def _node(kind, name, frame, color, props=(), message="", children="", values=""):
    body = "".join([_prop("s", "name", name), _prop("r", "frame", frame),
                    _prop("c", "color", color)] + [_prop(*p) for p in props])
    return (f"<node ID='{uuid.uuid4()}' type='{kind}'><properties>{body}</properties>"
            f"<values>{values}</values><messages>{message}</messages>"
            f"<children>{children}</children></node>")


RED, GREEN, BLUE, GOLD, GREY = ((1, 0.2, 0.2, 1), (0.2, 0.9, 0.4, 1), (0.3, 0.6, 1, 1),
                                (1, 0.8, 0.2, 1), (0.5, 0.5, 0.5, 1))


def label(text, frame, color=GREY):
    return _node("LABEL", text, frame, color, values=_value("text", escape(text)))


def fader(address, frame, color, lo=0, hi=1, horizontal=False, interactive=True):
    props = [("b", "interactive", 1 if interactive else 0),
             ("i", "orientation", 1 if horizontal else 0)]
    return _node("FADER", address, frame, color, props,
                 _osc_message(address, lo, hi, send=interactive))


def button(address, frame, color, toggle=False):
    return _node("BUTTON", address, frame, color, [("i", "buttonType", 1 if toggle else 0)],
                 _osc_message(address))


def panel_xml(w, h, items):
    return ("<?xml version='1.0' encoding='UTF-8'?><lexml version='3'>"
            + _node("GROUP", "root", (0, 0, w, h), (0.05, 0.05, 0.08, 1),
                    [("b", "background", 1)], children="".join(items))
            + "</lexml>")


def _row_of_buttons(prefix, modes, y, color, width=150, height=120, gap=15):
    items = []
    for i, mode in enumerate(modes):
        x = 20 + i * (width + gap)
        items.append(button(f"{prefix}/{mode}", (x, y, width, height), color))
        items.append(label(str(mode).upper(), (x, y + height + 5, width, 40)))
    return items


def layout_items(console):
    """(width, height, [nodes]) for one console's panel, for a landscape tablet."""
    items = []
    if console == "helm":
        # The game's own helm: an impulse lever, a REV toggle, and warp in steps - not one
        # fader for all three, which put impulse in a thin strip at the bottom.
        items += [label("IMPULSE", (20, 10, 160, 40)),
                  fader("/helm/impulse", (40, 60, 120, 520), GREEN, 0, 1),
                  button("/helm/reverse", (40, 600, 120, 90), GOLD, toggle=True),
                  label("REV", (40, 695, 120, 40)),
                  label("WARP", (190, 10, 110, 40))]
        for i, n in enumerate((4, 3, 2, 1, 0)):
            y = 60 + i * 110
            items.append(button(f"/helm/warp/{n}", (190, y, 110, 95), BLUE))
            items.append(label(f"WARP {n}" if n else "WARP OFF", (190, y + 30, 110, 36)))
        items += [button("/helm/red_alert", (330, 60, 200, 130), RED, toggle=True),
                  label("RED ALERT", (330, 195, 200, 40)),
                  button("/helm/shields", (560, 60, 200, 130), BLUE, toggle=True),
                  label("SHIELDS", (560, 195, 200, 40)),
                  button("/helm/stop", (330, 270, 200, 110), GOLD),
                  label("ALL STOP", (330, 385, 200, 40)),
                  button("/helm/dock", (560, 270, 95, 110), GREEN),
                  button("/helm/undock", (665, 270, 95, 110), GREY),
                  label("DOCK   UNDOCK", (560, 385, 200, 40)),
                  label("HEADING", (330, 470, 430, 40)),
                  fader("/helm/heading", (330, 520, 430, 100), BLUE, 0, 360, horizontal=True)]
        gauges = [("/state/shields/front", "FRONT", BLUE, 0, 1),
                  ("/state/shields/rear", "REAR", BLUE, 0, 1),
                  ("/state/energy", "ENERGY", GOLD, 0, 1000),
                  ("/state/warp", "WARP", BLUE, 0, 4)]
    elif console == "weapons":
        items += [label("WEAPONS TARGET", (20, 10, 600, 40))]
        items += _row_of_buttons("/weapons/target", ("nearest", "prev", "next", "clear"), 60, RED,
                                 width=110, height=110)
        items += [label("FIRE", (20, 250, 480, 40))]
        kinds = ("Homing", "Nuke", "EMP", "Mine", "PShock", "Tag")
        items += _row_of_buttons("/weapons/fire", kinds[:3], 300, GOLD, height=140)
        items += _row_of_buttons("/weapons/fire", kinds[3:], 490, GOLD, height=140)
        gauges = [(f"/state/torps/{k.lower()}", k.upper(), GOLD, 0, 10) for k in kinds]
    elif console == "science":
        items += [label("SCIENCE TARGET", (20, 10, 480, 40))]
        items += _row_of_buttons("/science/target", ("nearest", "prev", "next"), 60, BLUE, height=150)
        gauges = [("/state/shields/front", "FRONT", BLUE, 0, 1),
                  ("/state/shields/rear", "REAR", BLUE, 0, 1)]
    elif console == "comms":
        items += [label("COMMS TARGET", (20, 10, 480, 40))]
        items += _row_of_buttons("/comms/target", ("nearest", "prev", "next"), 60, GREEN)
        items += [label("COMMS BUTTONS", (20, 250, 480, 40))]
        items += _row_of_buttons("/comms/button", (0, 1, 2), 300, GREEN)
        items += _row_of_buttons("/comms/button", (3, 4, 5), 470, GREEN)
        items += [button("/helm/red_alert", (540, 60, 200, 120), RED, toggle=True),
                  label("RED ALERT", (540, 185, 200, 40))]
        gauges = []
    elif console == "engineering":
        systems = ("beam", "torp", "impulse", "warp", "maneuver", "sensors",
                   "front_shield", "rear_shield")
        items.append(label("POWER (0-300%)", (20, 10, 700, 40)))
        for i, name in enumerate(systems):
            x = 20 + i * 95
            items.append(fader(f"/eng/power/{name}", (x, 60, 80, 460), GOLD, 0, 3))
            items.append(label(name.replace("_", " ").upper(), (x - 5, 525, 90, 40)))
        items.append(label("COOLANT", (20, 590, 400, 40)))
        for i in range(4):
            items.append(fader(f"/eng/coolant/{i}", (20 + i * 190, 630, 170, 70), BLUE, 0, 8,
                               horizontal=True))
        gauges = [(f"/state/heat/{i}", f"HEAT {i}", RED, 0, 1) for i in range(4)]
    else:
        raise click.BadParameter(f"no layout for {console!r}")
    for i, (address, text, color, lo, hi) in enumerate(gauges):
        y = 60 + i * 110
        items.append(label(text, (820, y, 180, 36)))
        items.append(fader(address, (820, y + 38, 180, 50), color, lo, hi,
                           horizontal=True, interactive=False))
    return 1024, 768, items


CONSOLES = ("helm", "weapons", "science", "comms", "engineering")


@osc.command("layout", short_help="Write a TouchOSC layout (.tosc) for a console.")
@click.argument("console", type=click.Choice(CONSOLES + ("all",)))
@click.option("-o", "--out", default=".", show_default=True,
              help="A .tosc file, or a folder (one file per console).")
@click.option("--xml", "also_xml", is_flag=True, help="Also write the plain XML, for debugging.")
def layout(console, out, also_xml):
    """Generate a TouchOSC panel for CONSOLE, bound to the engine's OSC addresses.

    EXPERIMENTAL: open the file in the TouchOSC editor once before relying on it.
    """
    wanted = CONSOLES if console == "all" else (console,)
    for name in wanted:
        w, h, items = layout_items(name)
        xml = panel_xml(w, h, items)
        single = out.lower().endswith(".tosc") and len(wanted) == 1
        path = out if single else os.path.join(out, f"{name}.tosc")
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "wb") as f:
            f.write(zlib.compress(xml.encode("utf-8")))
        if also_xml:
            with open(path[:-5] + ".xml", "w", encoding="utf-8") as f:
                f.write(xml)
        click.echo(f"wrote {path}  ({len(items)} controls)")
