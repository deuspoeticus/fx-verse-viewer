#!/usr/bin/env node
/**
 * archive.mjs — pulls FX(VERSE) straight from Ethereum. No fxhash servers.
 *
 *  1. Generator: walks the onchfs directory inode on the onchfs FileSystem
 *     contract, reads every file chunk-by-chunk, decodes its metadata,
 *     gunzips if needed, and writes it to ./generator/
 *  2. Tokens: reads totalSupply(), then genArtInfo(id) (minter, seed,
 *     fxParams) and ownerOf(id) for every token, and writes ./tokens.json
 *
 * Usage:  npm install && npm run archive
 * Env:    ETH_RPC=https://your-rpc  (optional, tried first)
 */
import { createPublicClient, http, fallback, hexToBytes } from "viem";
import { mainnet } from "viem/chains";
import Onchfs from "onchfs";
import { gunzipSync, inflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONTRACT = "0x3f4A55Bd3CaA78e7Abe9bDc5DF10131170834029";
// Generator bundle, content-addressed: the CID is the hash of the directory,
// so what the FileSystem contract returns for it can't be anything else.
const GENERATOR_CID = "0x5a33b10417d306b3d1f1c6e4a691052ba7c0c81bb54c2b3eed101d6e471f49a6";
const FILESYSTEM = "0x9e0f2864c6f125bbf599df6ca6e6c3774c5b2e04"; // onchfs on Ethereum
const CHUNK_BATCH = 5;

const RPCS = [
  process.env.ETH_RPC,
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
].filter(Boolean);

const client = createPublicClient({
  chain: mainnet,
  transport: fallback(RPCS.map((u) => http(u, { timeout: 20_000 })), { rank: false, retryCount: 3 }),
});

const fsAbi = [
  {
    type: "function", name: "inodes", stateMutability: "view",
    inputs: [{ name: "checksum", type: "bytes32" }],
    outputs: [
      { name: "inodeType", type: "uint8" },
      { name: "file", type: "tuple", components: [
        { name: "metadata", type: "bytes" }, { name: "chunkChecksums", type: "bytes32[]" }] },
      { name: "directory", type: "tuple", components: [
        { name: "filenames", type: "string[]" }, { name: "fileChecksums", type: "bytes32[]" }] },
    ],
  },
  {
    type: "function", name: "concatenateChunks", stateMutability: "view",
    inputs: [{ name: "_pointers", type: "bytes32[]" }],
    outputs: [{ name: "fileContent", type: "bytes" }],
  },
];

const nftAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "genArtInfo", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ name: "minter", type: "address" }, { name: "seed", type: "bytes32" }, { name: "fxParams", type: "bytes" }] },
];

// Same determinism patch fxhash's own viewer injected (base58 Math.pow fix).
const PATCH = `<script>(function(){Math.pow=(a,b)=>(a===58&&b===11)?24986644000165536000:a**b})();</script>`;

const inode = (cid) => client.readContract({ address: FILESYSTEM, abi: fsAbi, functionName: "inodes", args: [cid] });

async function readFileInode(file) {
  const ptrs = [...file.chunkChecksums];
  const parts = [];
  for (let i = 0; i < ptrs.length; i += CHUNK_BATCH) {
    const hex = await client.readContract({
      address: FILESYSTEM, abi: fsAbi, functionName: "concatenateChunks", args: [ptrs.slice(i, i + CHUNK_BATCH)],
    });
    parts.push(Buffer.from(hexToBytes(hex)));
  }
  let body = Buffer.concat(parts);
  let meta = {};
  try { meta = Onchfs.metadata.decode(hexToBytes(file.metadata)); } catch {}
  const enc = String(meta["Content-Encoding"] || meta["content-encoding"] || "").toLowerCase();
  if (enc === "gzip") body = gunzipSync(body);
  else if (enc === "deflate") body = inflateSync(body);
  return { body, meta };
}

async function walk(cid, relPath, outDir, manifest) {
  const [type, file, dir] = await inode(cid);
  if (type === 1) {
    const { body, meta } = await readFileInode(file);
    let out = body;
    if (/(^|\/)index\.html$/i.test(relPath)) {
      const html = body.toString("utf8");
      const i = html.search(/<head[^>]*>/i);
      out = Buffer.from(i === -1 ? PATCH + html
        : html.replace(/<head[^>]*>/i, (m) => m + "\n" + PATCH));
    }
    const target = join(outDir, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, out);
    manifest.push({ path: relPath, cid, bytes: body.length, type: meta["Content-Type"] || meta["content-type"] || "" });
    console.log(`  ${relPath}  (${body.length} B)`);
    return;
  }
  if (type !== 0) throw new Error(`Unknown inode type ${type} at ${relPath || "/"}`);
  for (let i = 0; i < dir.filenames.length; i++) {
    await walk(dir.fileChecksums[i], relPath ? `${relPath}/${dir.filenames[i]}` : dir.filenames[i], outDir, manifest);
  }
}

async function archiveGenerator() {
  console.log(`Generator onchfs://${GENERATOR_CID.slice(2)}`);
  const manifest = [];
  await walk(GENERATOR_CID, "", "generator", manifest);
  if (!manifest.some((f) => f.path === "index.html")) throw new Error("No index.html in generator bundle");
  writeFileSync("generator/_onchfs.json", JSON.stringify({ cid: GENERATOR_CID, chain: "ethereum", filesystem: FILESYSTEM, files: manifest }, null, 2));
}

async function archiveTokens() {
  const supply = Number(await client.readContract({ address: CONTRACT, abi: nftAbi, functionName: "totalSupply" }));
  console.log(`\nTokens: totalSupply = ${supply}`);
  const tokens = [];
  // fxhash collections are 1-indexed; probe 0 too in case.
  for (let id = 0; id <= supply; id++) {
    try {
      const [minter, seed, fxParams] = await client.readContract({ address: CONTRACT, abi: nftAbi, functionName: "genArtInfo", args: [BigInt(id)] });
      if (/^0x0{64}$/.test(seed)) continue;
      let owner = "";
      try { owner = await client.readContract({ address: CONTRACT, abi: nftAbi, functionName: "ownerOf", args: [BigInt(id)] }); } catch {}
      tokens.push({ id, seed, minter, owner, fxParams: fxParams === "0x" ? "" : fxParams.slice(2) });
      console.log(`  #${id}  ${seed}`);
    } catch { /* nonexistent id */ }
  }
  writeFileSync("tokens.json", JSON.stringify({
    contract: CONTRACT, chain: "ethereum", generator: `onchfs://${GENERATOR_CID.slice(2)}`,
    totalSupply: supply, snapshotAt: new Date().toISOString(), tokens,
  }, null, 2));
}

await archiveGenerator();
await archiveTokens();
console.log("\nDone. Serve this folder (npm run serve) and open http://localhost:8000");
