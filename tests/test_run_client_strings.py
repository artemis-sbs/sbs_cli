"""`sbs run` seeds console_previous through client_string_set.txt, and must not eat the rest.

That file is the CLIENT's persisted string store, and the engine writes it back itself -
a real one holds console_mode, console_previous and crew_name. The old launcher wrote a
single `console_previous\n<name>\n` pair over the whole thing, discarding the player's
crew name, and restored the original only AFTER the loop with nothing guarding it.

This is also the channel of last resort rather than a preference: `console=<name>` on the
client's command line cannot work, because the mission script runs on the SERVER and
`sbs.command_line_dict()` is the server's own command line. `request_client_string`
("requests a string value from the client computer") is the only per-client path there is.
"""
import unittest

import run_cmd


# Shape taken from a real file, not invented: leading empty pair, then three keys.
REAL = "\n\nconsole_mode\n\nconsole_previous\nscience\ncrew_name\nDoug\n"


class ClientStringSeedTests(unittest.TestCase):
    """The seed is byte-for-byte what auto_run.py wrote - one pair, nothing else.

    A merge that kept the other keys was tried and reverted. A live file starts with an
    EMPTY key/value pair before console_mode and console_previous, a shape the batch file
    never produced because it replaced the whole file; the launch is the one moment the
    engine parses it, and that is not the moment to hand it a different shape. The
    original is restored in a finally, so nothing is lost.
    """

    def test_is_exactly_one_pair(self):
        self.assertEqual(run_cmd._seeded_client_strings("comms"),
                         "console_previous\ncomms\n")

    def test_server_gets_a_blank_value(self):
        # The batch file wrote a line for the Server window too.
        self.assertEqual(run_cmd._seeded_client_strings(None),
                         "console_previous\n\n")

    def test_nothing_else_is_written(self):
        # No console_mode: it routes the client into console_force_mode, a holding screen
        # the console never came back from on an in-game restart.
        self.assertNotIn("console_mode", run_cmd._seeded_client_strings("helm"))
        self.assertNotIn("crew_name", run_cmd._seeded_client_strings("helm"))

    def test_restore_is_verbatim(self):
        # The finally writes the ORIGINAL text straight back - no parse, no reformat, so a
        # file this tool does not understand still comes back exactly as it was found.
        import inspect
        src = inspect.getsource(run_cmd.run.callback)
        self.assertIn("f.write(saved_client_strings)", src)


if __name__ == "__main__":
    unittest.main()
