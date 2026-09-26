// Fail closed before any credentialed Python fetch; diagnostics never echo input.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const refuse = (line, kind) => { throw new Error(`registries: Python line ${line}: ${kind} is not allowed with credentials`); };
function requirement(value, line, cwd) {
  if (/(?:^|\s)--?[^\s]/.test(value)) refuse(line, 'requirements option');
  const dep = value.split(';')[0].trim();
  if (/^(git|hg|svn|bzr)\+/i.test(dep)) refuse(line, 'VCS requirement');
  if (dep.includes('@') || /^[a-z][a-z0-9+.-]*:/i.test(dep)) refuse(line, 'URL requirement');
  if (fs.existsSync(path.join(cwd, dep)) || /[/\\]|^\.|\.(whl|zip|tar|gz|bz2|xz)$/i.test(dep)) refuse(line, 'path requirement');
  // Accept only named index requirements. Unknown syntax cannot enable a build.
  if (!/^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9_., -]+\])?\s*(?:\(?\s*(?:===|~=|==|!=|<=|>=|<|>)\s*[a-z0-9.*+!_-]+(?:\s*,\s*(?:===|~=|==|!=|<=|>=|<|>)\s*[a-z0-9.*+!_-]+)*\s*\)?)?$/i.test(dep)) refuse(line, 'unsupported requirement');
}

export function requirementsInputs(cwd, roots, validate) {
  const files = [], seen = new Map();
  function visit(source, line = 1) {
    const absolute = path.resolve(cwd, source), root = fs.realpathSync(cwd);
    try {
      if (!fs.realpathSync(absolute).startsWith(root + path.sep) || !fs.statSync(absolute).isFile()) refuse(line, 'escaping requirements include');
    } catch { refuse(line, 'escaping requirements include'); }
    source = path.relative(cwd, absolute);
    if (seen.has(source)) return seen.get(source);
    const index = files.length;
    seen.set(source, index);
    const file = { source, destination: `py/req-${index}.txt` };
    files.push(file);
    const input = fs.readFileSync(absolute, 'utf8');
    const lines = input.split(/\r?\n/), output = [];
    let rewritten = false;
    for (let i = 0; i < lines.length; i++) {
      const number = i + 1;
      let text = lines[i];
      while (/\\\s*$/.test(text) && i + 1 < lines.length) text = text.replace(/\\\s*$/, '') + lines[++i];
      const clean = text.replace(/(^|\s)#.*$/, '').trim();
      const include = clean.match(/^(?:-r\s*|--requirement(?:=|\s+)|-c\s*|--constraint(?:=|\s+))(.+)$/);
      if (include) {
        let target = include[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        if (path.isAbsolute(target) || /^[a-z]+:/i.test(target)) refuse(number, 'escaping requirements include');
        const child = visit(path.join(path.dirname(source), target), number);
        output.push(`${/^(-c|--constraint)/.test(clean) ? '-c' : '-r'} req-${child}.txt`);
        rewritten = true;
        continue;
      }
      if (validate && clean) {
        if (/^(-e|--editable)(\s|=|\S)/.test(clean)) refuse(number, 'editable requirement');
        if (clean.startsWith('-')) {
          const allowed = /^(?:--index-url(?:=|\s+)|-i\s*|--extra-index-url(?:=|\s+)|--find-links(?:=|\s+))https:\/\/[^\s]+$/.test(clean)
            || /^--trusted-host(?:=|\s+)[a-z0-9.-]+(?::\d+)?$/i.test(clean)
            || /^--require-hashes$/.test(clean)
            || /^--hash(?:=|\s+)[a-z0-9]+:[a-f0-9]+$/i.test(clean);
          if (!allowed) refuse(number, 'requirements option');
        } else {
          const withoutHashes = clean.replace(/\s+--hash(?:=|\s+)[a-z0-9]+:[a-f0-9]+/gi, '');
          requirement(withoutHashes, number, cwd);
        }
      }
      output.push(text);
    }
    if (rewritten) file.content = output.join('\n');
    return index;
  }
  const indexes = roots.map(source => visit(source));
  return { files, indexes };
}

export function validatePythonProject(cwd, manager) {
  // tomllib parses data only; never import or execute project code. Suppress
  // parser diagnostics, which can contain dependency URLs or credentials.
  function parse(name) {
    try {
      return JSON.parse(execFileSync('python3', ['-I', '-c', 'import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], {
        input: fs.readFileSync(path.join(cwd, name), 'utf8'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
      }));
    } catch { throw new Error(`registries: cannot safely parse ${name} (Python 3.11+ required)`); }
  }
  const project = parse('pyproject.toml');
  const lists = [project.project?.dependencies ?? [], ...Object.values(project.project?.['optional-dependencies'] ?? {}), ...Object.values(project['dependency-groups'] ?? {})];
  for (const list of lists) for (const dep of list) {
    if (typeof dep === 'string') requirement(dep, 'dependency list', cwd);
    else if (!(dep && typeof dep['include-group'] === 'string' && Object.keys(dep).length === 1)) refuse('dependency list', 'unsupported requirement');
  }
  if (manager === 'uv') {
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (value.source && ['git', 'url', 'path', 'directory', 'editable'].some(key => Object.hasOwn(value.source, key))) {
        // The root virtual project is not installed; all dependency sources are checked.
        refuse('uv.lock', 'git/url/path source');
      }
      for (const child of Object.values(value)) walk(child);
    };
    walk(parse('uv.lock'));
  }
}
