#!/usr/bin/env node
'use strict';

const fs = require('fs');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  fail('Usage: node ua-tour-analyze.js <input.json> <output.json>');
}

let data;
try {
  data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (e) {
  fail('Failed to read/parse input JSON: ' + e.message);
}

const nodes = Array.isArray(data.nodes) ? data.nodes : [];
const edges = Array.isArray(data.edges) ? data.edges : [];
const layers = Array.isArray(data.layers) ? data.layers : [];

try {
  const nodeById = new Map();
  for (const n of nodes) nodeById.set(n.id, n);

  // ---------- A & B: Fan-in / Fan-out ----------
  const fanIn = new Map();
  const fanOut = new Map();
  for (const n of nodes) {
    fanIn.set(n.id, 0);
    fanOut.set(n.id, 0);
  }
  for (const e of edges) {
    if (fanOut.has(e.source)) fanOut.set(e.source, fanOut.get(e.source) + 1);
    if (fanIn.has(e.target)) fanIn.set(e.target, fanIn.get(e.target) + 1);
  }

  const fanInRanking = [...fanIn.entries()]
    .map(([id, count]) => ({ id, fanIn: count, name: nodeById.get(id)?.name || id }))
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 20);

  const fanOutRanking = [...fanOut.entries()]
    .map(([id, count]) => ({ id, fanOut: count, name: nodeById.get(id)?.name || id }))
    .sort((a, b) => b.fanOut - a.fanOut)
    .slice(0, 20);

  // ---------- C: Entry point candidates ----------
  const entryFilenames = new Set([
    'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
    'server.ts', 'server.js', 'mod.rs', 'main.go', 'main.py', 'main.rs',
    'manage.py', 'app.py', 'wsgi.py', 'asgi.py', 'run.py', '__main__.py',
    'Application.java', 'Main.java', 'Program.cs', 'config.ru', 'index.php',
    'App.swift', 'Application.kt', 'main.cpp', 'main.c'
  ]);

  const fanOutValues = [...fanOut.values()];
  const fanInValues = [...fanIn.values()];
  const sortedFanOutDesc = [...fanOutValues].sort((a, b) => b - a);
  const sortedFanInAsc = [...fanInValues].sort((a, b) => a - b);
  const top10PctIdx = Math.max(0, Math.floor(sortedFanOutDesc.length * 0.1) - 1);
  const fanOutTop10PctThreshold = sortedFanOutDesc.length ? sortedFanOutDesc[top10PctIdx] : 0;
  const bottom25PctIdx = Math.max(0, Math.floor(sortedFanInAsc.length * 0.25) - 1);
  const fanInBottom25PctThreshold = sortedFanInAsc.length ? sortedFanInAsc[bottom25PctIdx] : 0;

  function pathDepth(filePath) {
    if (!filePath) return 99;
    return filePath.split('/').filter(Boolean).length;
  }

  const entryScores = [];
  for (const n of nodes) {
    let score = 0;
    const fp = n.filePath || '';
    const baseName = n.name || (fp.split('/').pop() || '');

    if (n.type === 'document') {
      const depth = pathDepth(fp);
      if (baseName === 'README.md' && depth <= 1) {
        score += 5;
      } else if (baseName.endsWith('.md') && depth <= 1) {
        score += 2;
      }
    } else if (n.type === 'file') {
      if (entryFilenames.has(baseName)) score += 3;
      const depth = pathDepth(fp);
      if (depth <= 2) score += 1;
      if (fanOut.get(n.id) >= fanOutTop10PctThreshold && fanOutTop10PctThreshold > 0) score += 1;
      if (fanIn.get(n.id) <= fanInBottom25PctThreshold) score += 1;
    }

    if (score > 0) {
      entryScores.push({ id: n.id, score, name: n.name, summary: n.summary });
    }
  }
  entryScores.sort((a, b) => b.score - a.score);
  const entryPointCandidates = entryScores.slice(0, 5);

  // ---------- D: BFS from top code entry point ----------
  // Pick top code (type: file) entry point candidate, skipping documents.
  let codeEntry = entryScores.find(c => {
    const node = nodeById.get(c.id);
    return node && node.type === 'file';
  });
  if (!codeEntry) {
    // fallback: highest fan-out file node
    const fileNodes = nodes.filter(n => n.type === 'file');
    if (fileNodes.length) {
      const best = fileNodes.map(n => ({ id: n.id, fo: fanOut.get(n.id) || 0 }))
        .sort((a, b) => b.fo - a.fo)[0];
      codeEntry = { id: best.id };
    }
  }

  const bfsTraversal = { startNode: null, order: [], depthMap: {}, byDepth: {} };
  if (codeEntry) {
    const startNode = codeEntry.id;
    bfsTraversal.startNode = startNode;

    const adj = new Map();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) {
      if ((e.type === 'imports' || e.type === 'calls') && adj.has(e.source)) {
        adj.get(e.source).push(e.target);
      }
    }

    const visited = new Set([startNode]);
    const queue = [[startNode, 0]];
    bfsTraversal.depthMap[startNode] = 0;
    let qi = 0;
    while (qi < queue.length) {
      const [cur, depth] = queue[qi++];
      bfsTraversal.order.push(cur);
      const neighbors = adj.get(cur) || [];
      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          bfsTraversal.depthMap[nb] = depth + 1;
          queue.push([nb, depth + 1]);
        }
      }
    }

    for (const [id, depth] of Object.entries(bfsTraversal.depthMap)) {
      const key = String(depth);
      if (!bfsTraversal.byDepth[key]) bfsTraversal.byDepth[key] = [];
      bfsTraversal.byDepth[key].push(id);
    }
  }

  // ---------- E: Non-code file inventory ----------
  const nonCodeFiles = {
    documentation: [],
    infrastructure: [],
    data: [],
    config: []
  };
  for (const n of nodes) {
    if (n.type === 'document') {
      nonCodeFiles.documentation.push({ id: n.id, name: n.name, summary: n.summary });
    } else if (n.type === 'service' || n.type === 'pipeline' || n.type === 'resource') {
      nonCodeFiles.infrastructure.push({ id: n.id, name: n.name, type: n.type, summary: n.summary });
    } else if (n.type === 'table' || n.type === 'schema' || n.type === 'endpoint') {
      nonCodeFiles.data.push({ id: n.id, name: n.name, type: n.type, summary: n.summary });
    } else if (n.type === 'config') {
      nonCodeFiles.config.push({ id: n.id, name: n.name, summary: n.summary });
    }
  }

  // ---------- F: Tightly coupled clusters ----------
  const edgeSet = new Set(edges.map(e => `${e.source}|||${e.target}|||${e.type}`));
  function hasEdge(a, b, types) {
    for (const t of types) {
      if (edgeSet.has(`${a}|||${b}|||${t}`)) return true;
    }
    return false;
  }

  const bidirPairs = [];
  const relTypes = ['imports', 'calls'];
  for (const e of edges) {
    if (!relTypes.includes(e.type)) continue;
    if (hasEdge(e.target, e.source, relTypes)) {
      const key = [e.source, e.target].sort().join('|||');
      bidirPairs.push(key);
    }
  }
  const uniqueBidirPairs = [...new Set(bidirPairs)];

  // Union-find to group bidirectional pairs into clusters
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const key of uniqueBidirPairs) {
    const [a, b] = key.split('|||');
    union(a, b);
  }

  const clusterGroups = new Map();
  for (const key of uniqueBidirPairs) {
    const [a, b] = key.split('|||');
    const root = find(a);
    if (!clusterGroups.has(root)) clusterGroups.set(root, new Set());
    clusterGroups.get(root).add(a);
    clusterGroups.get(root).add(b);
  }

  // Expand clusters: add nodes connecting to 2+ existing members (any edge type, either direction)
  const allEdgePairs = edges.map(e => [e.source, e.target]);
  for (const [root, memberSet] of clusterGroups.entries()) {
    let changed = true;
    while (changed && memberSet.size < 5) {
      changed = false;
      const connectionCount = new Map();
      for (const [s, t] of allEdgePairs) {
        if (memberSet.has(s) && !memberSet.has(t)) {
          connectionCount.set(t, (connectionCount.get(t) || 0) + 1);
        } else if (memberSet.has(t) && !memberSet.has(s)) {
          connectionCount.set(s, (connectionCount.get(s) || 0) + 1);
        }
      }
      for (const [candidate, count] of connectionCount.entries()) {
        if (count >= 2 && memberSet.size < 5) {
          memberSet.add(candidate);
          changed = true;
        }
      }
    }
  }

  let clusters = [...clusterGroups.values()]
    .filter(s => s.size >= 2 && s.size <= 5)
    .map(s => {
      const memberArr = [...s];
      let edgeCount = 0;
      for (const e of edges) {
        if (memberArr.includes(e.source) && memberArr.includes(e.target)) edgeCount++;
      }
      return { nodes: memberArr, edgeCount };
    })
    .sort((a, b) => b.edgeCount - a.edgeCount)
    .slice(0, 10);

  // ---------- G: Layers ----------
  const layersOut = {
    count: layers.length,
    list: layers.map(l => ({ id: l.id, name: l.name, description: l.description }))
  };

  // ---------- H: Node summary index ----------
  const nodeSummaryIndex = {};
  for (const n of nodes) {
    nodeSummaryIndex[n.id] = { name: n.name, type: n.type, summary: n.summary };
  }

  const result = {
    scriptCompleted: true,
    entryPointCandidates,
    fanInRanking,
    fanOutRanking,
    bfsTraversal,
    nonCodeFiles,
    clusters,
    layers: layersOut,
    nodeSummaryIndex,
    totalNodes: nodes.length,
    totalEdges: edges.length
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  process.exit(0);
} catch (e) {
  fail('Fatal error during analysis: ' + (e && e.stack ? e.stack : e));
}
