/** Verify real uBO parsing, resource resolution and third-party network behavior. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; }
const engineDir = option('--engine-dir');
assert.ok(engineDir, '--engine-dir is required; prepare_engine.py creates it');
const directory = path.resolve(engineDir);
const lock = JSON.parse(fs.readFileSync(path.join(root, 'verification/engine-lock.json')));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
assert.equal(manifest.ublock_commit, lock.ublock.commit);
assert.equal(manifest.lock_sha256, crypto.createHash('sha256').update(pythonJSON(lock)).digest('hex'), 'engine manifest lock differs');
// Python json.dumps uses spaces in the lock fingerprint. Recompute that representation below.
function pythonJSON(value) {
    if (Array.isArray(value)) return '[' + value.map(pythonJSON).join(', ') + ']';
    if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ': ' + pythonJSON(value[k])).join(', ') + '}';
    return JSON.stringify(value);
}
for (const [relative, digest] of Object.entries(manifest.files)) {
    assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'unsafe engine manifest path');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, relative))).digest('hex'), digest, `changed engine file ${relative}`);
}
const { AstFilterParser } = await import(pathToFileURL(path.join(directory, 'node/js/static-filtering-parser.js')));
const { pslInit, StaticNetFilteringEngine } = await import(pathToFileURL(path.join(directory, 'node/index.js')));
const { builtinScriptlets } = await import(pathToFileURL(path.join(directory, 'node/js/resources/scriptlets.js')));
const resourceMap = new Map();
for (const entry of builtinScriptlets) {
    resourceMap.set(entry.name.replace(/\.js$/, ''), entry);
    for (const alias of entry.aliases || []) resourceMap.set(alias.replace(/\.js$/, ''), entry);
}
const parser = new AstFilterParser();
const files = [...fs.readdirSync(root).filter(n => n.endsWith('.txt')).map(n => path.join(root, n)),
    ...fs.readdirSync(path.join(root, 'v2')).filter(n => n.endsWith('.txt')).map(n => path.join(root, 'v2', n))];
const mirror = option('--mirror-root');
if (mirror) {
    const mirrorDir = path.join(mirror, 'browser_filter_lists/filters');
    files.push(...fs.readdirSync(mirrorDir).filter(n => n.endsWith('.txt')).map(n => path.join(mirrorDir, n)));
}
let parsed = 0, requests = 0;
const expectedExternal = [], scriptlets = [], fingerprints = {};
const listRules = new Map();
for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    fingerprints[path.relative(root, file)] = crypto.createHash('sha256').update(raw).digest('hex');
    const networkRules = [];
    for (const [index, rawLine] of raw.split('\n').entries()) {
        const line = rawLine.trim();
        if (!line || line.startsWith('!') || line.startsWith('[')) continue;
        parser.parse(line);
        assert.ok(parser.isFilter() && !parser.hasError() && !parser.isUnsupported(), `${file}:${index + 1}: ${line}`);
        parsed++;
        if (parser.isNetworkFilter()) networkRules.push(line);
        if (parser.isScriptletFilter()) {
            const scriptletArgs = parser.getScriptletArgs();
            const token = scriptletArgs[0].replace(/\.js$/, '');
            if (!resourceMap.has(token)) {
                assert.ok((lock.optional_scriptlets[path.basename(file)] || []).includes(token), `unresolved default scriptlet: ${token}`);
                expectedExternal.push({ file: path.basename(file), token });
            } else {
                scriptlets.push({ file: path.basename(file), token });
            }
        }
    }
    if (networkRules.length) listRules.set(file, { raw, networkRules });
}
pslInit(fs.readFileSync(path.join(directory, 'public_suffix_list.dat'), 'utf8'));
const engine = await StaticNetFilteringEngine.create({ noPSL: true });
let ghostery;
if (option('--ghostery-entry')) {
    const entryPath = path.resolve(option('--ghostery-entry'));
    const packageRoot = path.resolve(path.dirname(entryPath), '../..');
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
    assert.equal(metadata.name, lock.secondary_engine.package, 'unexpected secondary engine package');
    assert.equal(metadata.version, lock.secondary_engine.version, 'secondary engine version differs from lock');
    assert.equal(entryPath, path.join(packageRoot, 'dist/esm/index.js'), 'unexpected secondary engine entry');
    const installedLock = fs.readFileSync(path.resolve(packageRoot, '../../..', 'package-lock.json'));
    const expectedLock = fs.readFileSync(path.join(root, 'verification/ghostery/package-lock.json'));
    assert.equal(crypto.createHash('sha256').update(installedLock).digest('hex'),
        crypto.createHash('sha256').update(expectedLock).digest('hex'), 'secondary dependency lock differs; use the supplied npm lock');
    const npmRecord = JSON.parse(expectedLock).packages['node_modules/' + lock.secondary_engine.package];
    assert.equal(npmRecord.integrity, lock.secondary_engine.integrity);
    ghostery = await import(pathToFileURL(entryPath));
}
const cases = [];
for (const [file, { raw, networkRules }] of listRules) {
    await engine.useLists([{ name: file, raw }]);
    const secondary = ghostery?.FiltersEngine.parse(raw);
    for (const rule of networkRules) {
        const match = /^\|\|([^/^]+)(?:\^|\/([^$]*))\$third-party(?:,script)?$/.exec(rule);
        assert.ok(match, `unsupported behavior fixture: ${rule}`);
        const host = match[1], suffix = match[2] === undefined ? '/probe.js' : '/' + match[2];
        const scriptOnly = rule.endsWith(',script');
        const scenarios = [
            ['third-party', 'https://example.org/', `https://${host}${suffix}`, 'script', true],
            ['subdomain', 'https://example.org/', `https://probe.${host}${suffix}`, 'script', true],
            ['first-party', `https://${host}/`, `https://${host}${suffix}`, 'script', false],
            ['host-boundary', 'https://example.org/', `https://${host}.example.org${suffix}`, 'script', false],
            ['URL-text', 'https://example.org/', `https://example.org/path/${host}`, 'script', false],
            ['type-scope', 'https://example.org/', `https://${host}${suffix}`, 'image', !scriptOnly],
        ];
        for (const [name, originURL, url, type, blocked] of scenarios) {
            const result = engine.matchRequest({ originURL, url, type });
            assert.equal(result === 1, blocked, `${file} / ${rule} / ${name}: uBO ${result}`);
            if (secondary) {
                const matched = secondary.match(ghostery.Request.fromRawDetails({ sourceUrl: originURL, url, type }));
                assert.equal(matched.match, blocked, `${file} / ${rule} / ${name}: Ghostery`);
            }
            requests++;
        }
    }
    const testRule = networkRules[0], host = /^\|\|([^/^]+)/.exec(testRule)[1];
    await engine.useLists([{ name: file, raw: raw + `\n@@||${host}^$third-party\n` }]);
    assert.equal(engine.matchRequest({ originURL: 'https://example.org/', url: `https://${host}/probe.js`, type: 'script' }), 2, 'user exception must override normal blocking');
    requests++;
    cases.push({ file: path.relative(root, file), network_rules: networkRules.length });
}
// Parent-domain consolidation must preserve coverage of the removed child rule.
await engine.useLists([{ raw: fs.readFileSync(path.join(root, 'ad.txt'), 'utf8') }]);
assert.equal(engine.matchRequest({ originURL: 'https://example.org/', url: 'https://click.a-ads.com/test', type: 'script' }), 1);
requests++;
const report = { passed: true, engine: 'uBlock Origin', commit: lock.ublock.commit,
    secondary_engine: ghostery ? lock.secondary_engine : null, parsed_rules: parsed, request_cases: requests,
    scope: 'real parsers and synthetic network requests; not live-site or video E2E',
    resolved_scriptlets: scriptlets, explicitly_optional_external_scriptlets: expectedExternal, lists: cases, files: fingerprints };
// Execute the actual built-in scriptlet with a synthetic fetch. Syntax/resource
// checks alone do not catch URL matcher escaping or property-parser delimiters.
parser.parse(fs.readFileSync(path.join(root, 'ad-ubo.txt'), 'utf8').split('\n').find(line => line.startsWith('twitch.tv##+js(no-fetch-if,')));
const fetchArgs = parser.getScriptletArgs();
const entry = resourceMap.get(fetchArgs[0]);
const dependencies = new Map();
for (const resource of builtinScriptlets) {
    dependencies.set(resource.name, resource);
    for (const alias of resource.aliases || []) dependencies.set(alias, resource);
}
const code = [], seen = new Set();
function collect(resource) {
    assert.ok(resource, 'missing scriptlet dependency');
    if (seen.has(resource.name)) return;
    seen.add(resource.name);
    for (const name of resource.dependencies || []) collect(dependencies.get(name));
    code.push(resource.fn.toString());
}
collect(entry);
const calls = [];
const sandbox = vm.createContext({Request, Response, Headers, URL, EventTarget, console,
    XMLHttpRequest: class {}, setTimeout, clearTimeout,
    fetch: async input => { calls.push(typeof input === 'string' ? input : input.url); return new Response('original'); }});
vm.runInContext('self=globalThis;const scriptletGlobals={};' + code.join('\n') + '\n' + entry.fn.name + '(...' + JSON.stringify(fetchArgs.slice(1)) + ');', sandbox, {timeout: 1000});
const fetchCases = [
    ['https://edge.ads.twitch.tv/test', ''],
    ['https://edge.ads.twitch.tv:443/test', ''],
    [new Request('https://edge.ads.twitch.tv/request'), ''],
    ['https://edge.ads.twitch.tv.evil.example/test', 'original'],
    ['https://www.twitch.tv/?url=https://edge.ads.twitch.tv/test', 'original'],
    ['https://usher.ttvnw.net/api/channel/hls/example.m3u8', 'original'],
];
for (const [input, expected] of fetchCases) assert.equal(await (await sandbox.fetch(input)).text(), expected, 'Twitch fetch boundary regression');
assert.equal(calls.length, 3);
report.scriptlet_behavior_cases = fetchCases.length;
if (option('--report')) fs.writeFileSync(option('--report'), JSON.stringify(report, null, 2) + '\n');
console.log(`ENGINE CHECK PASSED: ${parsed} parsed rules, ${requests} request cases${ghostery ? ', two engines' : ''}`);
