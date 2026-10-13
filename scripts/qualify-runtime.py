#!/usr/bin/env python3
"""Fail-closed, serial qualification in a fresh private checkout (stdlib only)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import resource
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import tomllib


def clean_environment(state, channel):
    # Never pass the agent's database, provider tokens, config or production HOME.
    return {
        'PATH': '/usr/local/qualification/bin:/usr/local/bin:/usr/bin:/bin',
        'HOME': str(state / 'home'), 'TMPDIR': str(state / 'tmp'),
        'XDG_CONFIG_HOME': str(state / 'config'), 'XDG_CACHE_HOME': str(state / 'cache'),
        'PAPERCLIP_HOME': str(state / 'paperclip'), 'PAPERCLIP_INSTANCE_ID': 'qualification',
        'CARGO_HOME': str(state / 'cargo'), 'CARGO_TARGET_DIR': str(state / 'target'),
        'RUSTUP_HOME': '/usr/local/rustup', 'RUSTUP_TOOLCHAIN': channel,
        'RUSTUP_AUTO_INSTALL': '0', 'CARGO_BUILD_JOBS': '2',
        'NODE_ENV': 'development', 'NODE_OPTIONS': '--max-old-space-size=4096',
        'npm_config_nodedir': '/usr/local', 'npm_config_workspace_concurrency': '1', 'CI': 'true',
        'PAPERCLIP_TELEMETRY_DISABLED': '1', 'DO_NOT_TRACK': '1',
        'PNPM_HOME': str(state / 'pnpm'), 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0',
        'LANG': 'C.UTF-8',
    }


def header_version(header):
    parts = []
    for name in ('MAJOR', 'MINOR', 'PATCH'):
        match = re.search(r'^#define NODE_' + name + r'_VERSION\s+(\d+)\s*$', header, re.M)
        if not match:
            raise RuntimeError('Node version header is incomplete')
        parts.append(match.group(1))
    return '.'.join(parts)


def output(command, cwd=None, env=None):
    return subprocess.check_output(command, cwd=cwd, env=env, text=True).strip()


def smoke(env, channel):
    if os.getuid() == 0 or platform.system() != 'Linux':
        raise RuntimeError('qualification requires a non-root Linux runtime UID')
    print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'architecture': platform.machine()}), flush=True)
    for command in (['cc', '--version'], ['c++', '--version'], ['make', '--version'],
                    ['pkg-config', '--version'], ['python3', '--version'], ['node', '--version'],
                    ['cargo', '--version'], ['rustc', '--version']):
        version = output(command, env=env)
        print(shlex.join(command) + '\n' + version, flush=True)
        if command[0] in ('cargo', 'rustc') and version.split()[1] != channel:
            raise RuntimeError('compiler version differs from runner-owned pin')
    headers = Path('/usr/local/include/node')
    if not (headers / 'node_api.h').is_file():
        raise RuntimeError('bundled Node API header is absent')
    expected = output(['node', '-p', 'process.versions.node'], env=env)
    if header_version((headers / 'node_version.h').read_text()) != expected:
        raise RuntimeError('Node executable/header version mismatch')
    print('Node executable/header match: ' + expected, flush=True)


def process_group_rss(group):
    total = 0
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) == group:
                status = (entry / 'status').read_text()
                match = re.search(r'^VmRSS:\s+(\d+) kB$', status, re.M)
                if match:
                    total += int(match.group(1))
        except (OSError, ValueError, IndexError):
            continue  # Processes can exit between /proc reads.
    return total


def run_step(name, command, cwd, env, evidence):
    print(name + ': ' + shlex.join(command), flush=True)
    start = time.monotonic()
    with (evidence / (name + '.log')).open('w') as log:
        log.write('$ ' + shlex.join(command) + '\n')
        log.flush()
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        peak_rss = 0
        try:
            while process.poll() is None:
                peak_rss = max(peak_rss, process_group_rss(process.pid))
                time.sleep(0.1)
        except BaseException:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait()
            raise
    code = process.returncode if process.returncode >= 0 else 128 - process.returncode
    with (evidence / 'steps.jsonl').open('a') as log:
        log.write(json.dumps({'name': name, 'argv': command, 'exitCode': code,
                              'elapsedSeconds': time.monotonic() - start, 'sampledProcessGroupPeakRSSKiB': peak_rss,
                              'childrenPeakRSSKiBSoFar': resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}) + '\n')
    if code:
        raise subprocess.CalledProcessError(code, command)


def disk_bytes(path):
    return int(output(['du', '-sb', str(path)]).split()[0])


def qualify(args, state, env, channel):
    repo = Path.cwd().resolve()
    # Existing staging scripts require runner/target; this is private and ignored.
    env['CARGO_TARGET_DIR'] = str(repo / 'packages/paperclip-runner/runner/target')
    evidence = state / 'evidence'
    # Evidence/state must never live inside the candidate tree.
    if state == repo or repo in state.parents:
        raise RuntimeError('state must be outside the private checkout')
    evidence.mkdir()
    head = output(['git', 'rev-parse', 'HEAD'], env=env)
    candidate = output(['git', 'rev-parse', args.candidate + '^{commit}'], env=env)
    base = output(['git', 'rev-parse', args.base + '^{commit}'], env=env)
    expected_tree = output(['git', 'rev-parse', candidate + '^{tree}'], env=env)
    actual_tree = output(['git', 'rev-parse', 'HEAD^{tree}'], env=env)
    status = output(['git', 'status', '--porcelain', '--untracked-files=all'], env=env)
    (evidence / 'status-before.txt').write_text(status + '\n')
    if status or actual_tree != expected_tree:
        raise RuntimeError('clean checkout and candidate tree equality are mandatory')
    if args.isolation_reviewed_tree != actual_tree:
        raise RuntimeError('isolation review must cover the actual candidate tree')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', args.image_digest):
        raise RuntimeError('record the actual running image digest, not a tag')
    output(['git', 'merge-base', '--is-ancestor', base, candidate], env=env)
    for name, extra in [('scope', []), ('deletions', ['--diff-filter=D'])]:
        (evidence / (name + '.txt')).write_text(output(
            ['git', 'diff', '--name-status', *extra, base, candidate], env=env) + '\n')
    if any(p.name == '.env' or p.name.startswith('.env.') and not p.name.endswith('.example')
           for p in repo.rglob('.env*') if 'node_modules' not in p.parts):
        raise RuntimeError('fresh checkout must contain no runtime .env files')
    if any(repo.rglob('node_modules')):
        raise RuntimeError('fresh checkout must have no existing node_modules')
    locks = [p for p in repo.rglob('*') if p.is_file() and p.name in ('pnpm-lock.yaml', 'Cargo.lock')]
    hashes = {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest() for p in locks}
    metadata = {'base': base, 'expectedCandidate': candidate, 'expectedTree': expected_tree,
                'actualHEAD': head, 'actualTree': actual_tree, 'imageDigest': args.image_digest,
                'isolationReviewedTree': args.isolation_reviewed_tree, 'lockfiles': hashes,
                'uid': os.getuid(), 'architecture': platform.machine(), 'compilerPin': channel}
    (evidence / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    before = disk_bytes(repo) + disk_bytes(state)
    start = time.monotonic()
    try:
        run_step('smoke', [sys.executable, str(repo / 'scripts/qualify-runtime.py'), 'smoke'], repo, env, evidence)
        run_step('install', ['pnpm', 'install', '--frozen-lockfile', '--prod=false',
                             '--store-dir', str(state / 'store')], repo, env, evidence)
        broker = repo / 'packages/tailscale-https-broker'
        run_step('broker-compile', ['node', 'scripts/build-native.mjs'], broker, env, evidence)
        run_step('broker-load', ['node', '-e',
            "const a=require('./dist/peercred-native.node'); if(typeof a.getPeerCredentials!=='function')throw Error('missing native export'); try{a.getPeerCredentials(-1);throw Error('missing native validation')}catch(e){if(!(e instanceof TypeError))throw e} console.log('compiled broker addon loaded');"], broker, env, evidence)
        run_step('runner-locked', ['cargo', 'build', '--release', '--locked', '--manifest-path',
            'runner/Cargo.toml', '-p', 'paperclip-runner-core', '--bin', 'paperclip-runnerd'],
            repo / 'packages/paperclip-runner', env, evidence)
        for name, command in [('root-typecheck', ['pnpm', 'typecheck']),
                              ('recursive-typecheck', ['pnpm', '-r', 'typecheck']),
                              ('tests', ['pnpm', 'test:run']), ('build', ['pnpm', 'build'])]:
            run_step(name, command, repo, env, evidence)
    finally:
        after = output(['git', 'status', '--porcelain', '--untracked-files=all'], env=env)
        tracked = output(['git', 'diff', 'HEAD', '--name-status'], env=env)
        (evidence / 'status-after.txt').write_text(after + '\n')
        (evidence / 'tracked-changes-after.txt').write_text(tracked + '\n')
        (evidence / 'ignored-after.txt').write_text(output(['git', 'ls-files', '--others', '--ignored', '--exclude-standard'], env=env) + '\n')
        metadata.update(elapsedSeconds=time.monotonic() - start,
                        diskGrowthBytes=disk_bytes(repo) + disk_bytes(state) - before,
                        childrenPeakRSSKiB=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
        (evidence / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    if tracked or after or any(hashlib.sha256((repo / p).read_bytes()).hexdigest() != h for p, h in hashes.items()):
        raise RuntimeError('source/lockfile or untracked changes require review and requalification')
    print('Command checks passed. Health/responsiveness evidence and independent scope review still required.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    sub.add_parser('smoke')
    full = sub.add_parser('qualify')
    for option in ('base', 'candidate', 'image-digest', 'isolation-reviewed-tree', 'state'):
        full.add_argument('--' + option, required=True)
    args = parser.parse_args()
    pin = Path(__file__).resolve().parents[1] / 'packages/paperclip-runner/rust-toolchain.toml'
    if not pin.exists():
        pin = Path('/usr/local/share/qualification/rust-toolchain.toml')
    channel = tomllib.loads(pin.read_text())['toolchain']['channel']
    if args.mode == 'smoke':
        with tempfile.TemporaryDirectory(prefix='qualification-smoke-') as temp:
            state = Path(temp)
            env = clean_environment(state, channel)
            for key in ('HOME', 'TMPDIR', 'CARGO_HOME'):
                Path(env[key]).mkdir(parents=True)
            smoke(env, channel)
    else:
        state = Path(args.state).resolve()
        repo = Path.cwd().resolve()
        if state == repo or repo in state.parents:
            raise RuntimeError('state must be outside the private checkout')
        state.mkdir(mode=0o700, parents=True, exist_ok=False)
        env = clean_environment(state, channel)
        for key in ('HOME', 'TMPDIR', 'CARGO_HOME', 'PAPERCLIP_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'):
            Path(env[key]).mkdir(parents=True)
        qualify(args, state, env, channel)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print('FAILED: ' + shlex.join(error.cmd) + ' exit=' + str(error.returncode), file=sys.stderr)
        sys.exit(error.returncode if 0 < error.returncode < 256 else 1)
    except (RuntimeError, OSError) as error:
        print('FAILED: ' + str(error), file=sys.stderr)
        sys.exit(1)
