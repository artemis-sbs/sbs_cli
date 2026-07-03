# sbs_cli tests

Plain-stdlib `unittest` (no pytest, no extra deps). Run from the repo root:

```
python -m unittest discover -s tests
python -m unittest discover -s tests -v      # verbose
python -m unittest tests.test_fetch_cmd      # one module
```

`tests/_bootstrap.py` puts `src/` on `sys.path` (the modules use flat absolute
imports like `from file_help import curlretrieve`); import it first in every
test file.

## Mocking instead of real downloads

No test hits the network or shells out to `curl`. Three seams, from lowest to
highest level:

| Seam | Patch | Use it to test |
|---|---|---|
| `subprocess.run` | `mock.patch.object(subprocess, "run", ...)` | `curlretrieve` itself — that it returns True/False and passes `-f` |
| `curlretrieve` | `mock.patch.object(fetch_cmd, "curlretrieve", fake)` | `fetch_cmd` logic — the fake writes a real in-memory zip (or nothing) to `localname` |
| whole command | `click.testing.CliRunner().invoke(cli, [...])` | the Click layer end-to-end (options, prompts) |

**Patch where the name is looked up.** `fetch_cmd` does
`from file_help import curlretrieve`, so it has its *own* `fetch_cmd.curlretrieve`
binding — patch that, not `file_help.curlretrieve`.

**Redirect the filesystem.** `fetch` cleans/creates folders relative to
`zipapp_dir` (and the CWD). Tests patch `fetch_cmd.zipapp_dir` to a `tempfile`
dir and `os.chdir` there, so nothing touches the real missions folder.

**Fake a GitHub archive** by building a zip whose entries live under a top-level
`Repo-main/` folder (`unzip_exclude` strips that first component) — see
`_make_github_archive` / `_fake_curl_writes_zip`.

## What's covered

- `curlretrieve`: success, HTTP error (404), missing curl, `-f` present.
- `unzip_exclude`: strips the top folder, honors excludes.
- `fetch_cmd` (issue #1 regression): a failed download **and** a non-zip payload
  each leave **no folder** behind; a real zip extracts correctly.
