import assert from 'node:assert/strict';
import {test} from 'node:test';
import sharp from 'sharp';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);

test('patched native Sharp renders a bounded synthetic SVG with measured provider pins unchanged', async () => {
  assert.equal(sharp.versions.sharp, '0.35.5');
  assert.equal(require('miniflare/package.json').version, '4.20260730.0');
  assert.equal(require('workerd').version, '1.20260730.1');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#ff0000"/></svg>');
  const {data, info} = await sharp(svg, {limitInputPixels:4}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width, 2);
  assert.equal(info.height, 2);
  assert.equal(info.channels, 4);
  assert.deepEqual(data, Buffer.from([255,0,0,255,255,0,0,255,255,0,0,255,255,0,0,255]));
});
