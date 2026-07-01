#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) fail('Usage: node ua-arch-analyze.js <input.json> <output.json>');

let data;
try {
  data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (e) {
  fail('Failed to read/parse input JSON: ' + e.message);
}

const fileNodes = data.fileNodes || [];
const importEdges = data.importEdges || [];
const allEdges = data.allEdges || [];

if (!Array.isArray(fileNodes) || fileNodes.length === 0) fail('No fileNodes provided');

const nodeById = new Map();
for (const n of fileNodes) nodeById.set(n.id, n);

// ---------- A. Directory Grouping ----------
function dirOf(filePath) {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

const allPaths = fileNodes.map(n => n.filePath || n.name || '');

function commonPrefix(paths) {
  if (paths.length === 0) return '';
  const splitPaths = paths.map(p => p.split('/'));
  const minLen = Math.min(...splitPaths.map(p => p.length));
  const prefixParts = [];
  for (let i = 0; i < minLen - 1; i++) { // -1 to keep at least filename
    const seg = splitPaths[0][i];
    if (splitPaths.every(p => p[i] === seg)) {
      prefixParts.push(seg);
    } else {
      break;
    }
  }
  return prefixParts.length ? prefixParts.join('/') + '/' : '';
}

const prefix = commonPrefix(allPaths);

function groupKeyFor(filePath) {
  let rel = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
  const parts = rel.split('/');
  if (parts.length > 1) {
    return parts[0];
  }
  // flat file directly under prefix (or no subdirectory) - check root-level dir
  const fullParts = filePath.split('/');
  if (fullParts.length > 1) {
    return fullParts[0];
  }
  // truly flat - group by extension pattern
  const fname = fullParts[fullParts.length - 1];
  if (/\.test\./.test(fname) || /\.spec\./.test(fname)) return 'test';
  if (/\.config\./.test(fname)) return 'config';
  const ext = fname.includes('.') ? fname.slice(fname.lastIndexOf('.') + 1) : 'noext';
  return ext || 'root';
}

const directoryGroups = {};
for (const n of fileNodes) {
  const fp = n.filePath || n.name || '';
  const key = groupKeyFor(fp);
  if (!directoryGroups[key]) directoryGroups[key] = [];
  directoryGroups[key].push(n.id);
}

// ---------- B. Node Type Grouping ----------
const nodeTypeGroups = {};
for (const n of fileNodes) {
  const t = n.type || 'file';
  if (!nodeTypeGroups[t]) nodeTypeGroups[t] = [];
  nodeTypeGroups[t].push(n.id);
}

// ---------- C. Import Adjacency Matrix ----------
const fanOut = {};
const fanIn = {};
const importAdj = {}; // id -> Set of targets

for (const e of importEdges) {
  if (!nodeById.has(e.source) || !nodeById.has(e.target)) continue;
  fanOut[e.source] = (fanOut[e.source] || 0) + 1;
  fanIn[e.target] = (fanIn[e.target] || 0) + 1;
  if (!importAdj[e.source]) importAdj[e.source] = new Set();
  importAdj[e.source].add(e.target);
}

// id -> group lookup
const idToGroup = {};
for (const [group, ids] of Object.entries(directoryGroups)) {
  for (const id of ids) idToGroup[id] = group;
}

// group-level import sets
const groupImportsFrom = {}; // group -> Set(group)
const groupImportedBy = {}; // group -> Set(group)
for (const e of importEdges) {
  const sg = idToGroup[e.source];
  const tg = idToGroup[e.target];
  if (!sg || !tg) continue;
  if (!groupImportsFrom[sg]) groupImportsFrom[sg] = new Set();
  if (sg !== tg) groupImportsFrom[sg].add(tg);
  if (!groupImportedBy[tg]) groupImportedBy[tg] = new Set();
  if (sg !== tg) groupImportedBy[tg].add(sg);
}

// ---------- D. Cross-Category Dependency Analysis ----------
const crossCategoryMap = new Map();
for (const e of allEdges) {
  const s = nodeById.get(e.source);
  const t = nodeById.get(e.target);
  if (!s || !t) continue;
  const key = [s.type || 'file', t.type || 'file', e.type || 'related'].join('|');
  crossCategoryMap.set(key, (crossCategoryMap.get(key) || 0) + 1);
}
const crossCategoryEdges = [];
for (const [key, count] of crossCategoryMap.entries()) {
  const [fromType, toType, edgeType] = key.split('|');
  crossCategoryEdges.push({ fromType, toType, edgeType, count });
}
crossCategoryEdges.sort((a, b) => b.count - a.count);

// ---------- E. Inter-Group Import Frequency ----------
const interGroupMap = new Map();
for (const e of importEdges) {
  const sg = idToGroup[e.source];
  const tg = idToGroup[e.target];
  if (!sg || !tg || sg === tg) continue;
  const key = sg + '|' + tg;
  interGroupMap.set(key, (interGroupMap.get(key) || 0) + 1);
}
const interGroupImports = [];
for (const [key, count] of interGroupMap.entries()) {
  const [from, to] = key.split('|');
  interGroupImports.push({ from, to, count });
}
interGroupImports.sort((a, b) => b.count - a.count);

// ---------- F. Intra-Group Import Density ----------
const intraGroupDensity = {};
for (const group of Object.keys(directoryGroups)) {
  let internalEdges = 0;
  let totalEdges = 0;
  for (const e of importEdges) {
    const sg = idToGroup[e.source];
    const tg = idToGroup[e.target];
    if (sg !== group && tg !== group) continue;
    totalEdges++;
    if (sg === group && tg === group) internalEdges++;
  }
  intraGroupDensity[group] = {
    internalEdges,
    totalEdges,
    density: totalEdges > 0 ? internalEdges / totalEdges : 0
  };
}

// ---------- G. Directory Pattern Matching ----------
const dirPatternMap = {
  routes: 'api', api: 'api', controllers: 'api', endpoints: 'api', handlers: 'api',
  services: 'service', core: 'service', lib: 'service', domain: 'service', logic: 'service',
  models: 'data', db: 'data', data: 'data', persistence: 'data', repository: 'data', entities: 'data',
  components: 'ui', views: 'ui', pages: 'ui', ui: 'ui', layouts: 'ui', screens: 'ui',
  middleware: 'middleware', plugins: 'middleware', interceptors: 'middleware', guards: 'middleware',
  utils: 'utility', helpers: 'utility', common: 'utility', shared: 'utility', tools: 'utility',
  config: 'config', constants: 'config', env: 'config', settings: 'config',
  __tests__: 'test', test: 'test', tests: 'test', spec: 'test', specs: 'test',
  types: 'types', interfaces: 'types', schemas: 'types', contracts: 'types', dtos: 'types',
  hooks: 'hooks',
  store: 'state', state: 'state', reducers: 'state', actions: 'state', slices: 'state',
  assets: 'assets', static: 'assets', public: 'assets',
  migrations: 'data',
  management: 'config', commands: 'config',
  templatetags: 'utility',
  signals: 'service',
  serializers: 'api',
  cmd: 'entry',
  internal: 'service',
  pkg: 'utility',
  composables: 'service',
  blueprints: 'api',
  mailers: 'service', jobs: 'service', channels: 'service',
  bin: 'entry',
  docs: 'documentation', documentation: 'documentation', wiki: 'documentation',
  deploy: 'infrastructure', deployment: 'infrastructure', infra: 'infrastructure', infrastructure: 'infrastructure',
  '.github': 'ci-cd', '.gitlab': 'ci-cd', '.circleci': 'ci-cd',
  k8s: 'infrastructure', kubernetes: 'infrastructure', helm: 'infrastructure', charts: 'infrastructure',
  terraform: 'infrastructure', tf: 'infrastructure',
  docker: 'infrastructure',
  sql: 'data', database: 'data', schema: 'data'
};

const patternMatches = {};
for (const group of Object.keys(directoryGroups)) {
  const lower = group.toLowerCase();
  if (dirPatternMap[lower]) {
    patternMatches[group] = dirPatternMap[lower];
  } else {
    // check file-level patterns within the group
    const ids = directoryGroups[group];
    let label = null;
    for (const id of ids) {
      const n = nodeById.get(id);
      const fp = (n && n.filePath) || '';
      const fname = fp.split('/').pop() || '';
      if (/\.test\.|\.spec\.|^test_|_test\.go$|Test\.java$|_spec\.rb$|Test\.php$|Tests\.cs$/.test(fname)) {
        label = 'test'; break;
      }
      if (/\.d\.ts$/.test(fname)) { label = 'types'; break; }
      if (fname === 'docker-compose.yml' || /^Dockerfile/.test(fname) || /\.tf$|\.tfvars$/.test(fname)) { label = 'infrastructure'; break; }
      if (/\.sql$/.test(fname)) { label = 'data'; break; }
      if (/\.graphql$|\.gql$|\.proto$/.test(fname)) { label = 'types'; break; }
      if (/\.md$|\.rst$/.test(fname)) { label = 'documentation'; break; }
    }
    if (label) patternMatches[group] = label;
  }
}

// ---------- H. Deployment Topology Detection ----------
const infraFiles = [];
let hasDockerfile = false, hasCompose = false, hasK8s = false, hasTerraform = false, hasCI = false;
for (const n of fileNodes) {
  const fp = n.filePath || '';
  const fname = fp.split('/').pop() || '';
  if (/^Dockerfile/i.test(fname) || /\.Dockerfile$/i.test(fname)) { hasDockerfile = true; infraFiles.push(fp); }
  if (/docker-compose/i.test(fname)) { hasCompose = true; infraFiles.push(fp); }
  if (/\.ya?ml$/.test(fname) && /k8s|kubernetes/i.test(fp)) { hasK8s = true; infraFiles.push(fp); }
  if (/\.tf$|\.tfvars$/.test(fname)) { hasTerraform = true; infraFiles.push(fp); }
  if (/\.github\/workflows\//.test(fp) || /\.gitlab-ci\.yml$/.test(fname) || fname === 'Jenkinsfile') { hasCI = true; infraFiles.push(fp); }
}

// ---------- I. Data Pipeline Detection ----------
const schemaFiles = [];
const migrationFiles = [];
const dataModelFiles = [];
const apiHandlerFiles = [];
for (const n of fileNodes) {
  const fp = n.filePath || '';
  const fname = fp.split('/').pop() || '';
  if (/\.sql$/.test(fname) || /\.graphql$|\.gql$|\.proto$|\.prisma$/.test(fname)) schemaFiles.push(fp);
  if (/migrations\//.test(fp)) migrationFiles.push(fp);
  if (/models?\//.test(fp) || (n.tags || []).includes('model')) dataModelFiles.push(fp);
  if (/routes?\/|controllers?\/|api\//.test(fp) || (n.tags || []).includes('api-handler')) apiHandlerFiles.push(fp);
}

// ---------- J. Documentation Coverage ----------
const docFilesByDir = {};
for (const n of fileNodes) {
  if (n.type === 'document') {
    const fp = n.filePath || '';
    const dir = dirOf(fp) || '.';
    if (!docFilesByDir[dir]) docFilesByDir[dir] = [];
    docFilesByDir[dir].push(fp);
  }
}
let groupsWithDocs = 0;
const undocumentedGroups = [];
const totalGroups = Object.keys(directoryGroups).length;
for (const group of Object.keys(directoryGroups)) {
  const ids = directoryGroups[group];
  const hasDoc = ids.some(id => (nodeById.get(id) || {}).type === 'document') ||
    Object.keys(docFilesByDir).some(dir => dir.includes(group));
  if (hasDoc) groupsWithDocs++;
  else undocumentedGroups.push(group);
}
const coverageRatio = totalGroups > 0 ? groupsWithDocs / totalGroups : 0;

// ---------- K. Dependency Direction ----------
const dependencyDirection = [];
const seenPairs = new Set();
for (const { from, to, count } of interGroupImports) {
  const reverseKey = to + '|' + from;
  const forwardKey = from + '|' + to;
  if (seenPairs.has(forwardKey) || seenPairs.has(reverseKey)) continue;
  const reverseEntry = interGroupImports.find(x => x.from === to && x.to === from);
  const reverseCount = reverseEntry ? reverseEntry.count : 0;
  if (count > reverseCount) {
    dependencyDirection.push({ dependent: from, dependsOn: to });
  } else if (reverseCount > count) {
    dependencyDirection.push({ dependent: to, dependsOn: from });
  }
  seenPairs.add(forwardKey);
  seenPairs.add(reverseKey);
}

// ---------- File Stats ----------
const filesPerGroup = {};
for (const [group, ids] of Object.entries(directoryGroups)) filesPerGroup[group] = ids.length;
const nodeTypeCounts = {};
for (const [t, ids] of Object.entries(nodeTypeGroups)) nodeTypeCounts[t] = ids.length;

const result = {
  scriptCompleted: true,
  directoryGroups,
  nodeTypeGroups,
  crossCategoryEdges,
  interGroupImports,
  intraGroupDensity,
  patternMatches,
  deploymentTopology: {
    hasDockerfile,
    hasCompose,
    hasK8s,
    hasTerraform,
    hasCI,
    infraFiles: Array.from(new Set(infraFiles))
  },
  dataPipeline: {
    schemaFiles: Array.from(new Set(schemaFiles)),
    migrationFiles: Array.from(new Set(migrationFiles)),
    dataModelFiles: Array.from(new Set(dataModelFiles)),
    apiHandlerFiles: Array.from(new Set(apiHandlerFiles))
  },
  docCoverage: {
    groupsWithDocs,
    totalGroups,
    coverageRatio,
    undocumentedGroups
  },
  dependencyDirection,
  fileStats: {
    totalFileNodes: fileNodes.length,
    filesPerGroup,
    nodeTypeCounts
  },
  fileFanIn: fanIn,
  fileFanOut: fanOut
};

try {
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
} catch (e) {
  fail('Failed to write output JSON: ' + e.message);
}

console.log('Structural analysis complete. Output written to ' + outputPath);
process.exit(0);
