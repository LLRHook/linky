import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComponentType } from 'discord.js';
import { messageHasUploadedMedia } from '../src/services/UploadedMedia';

const name = 'post-video.mp4';
const ids = '123456789012345678/223456789012345678';
const panel = (url: string) => [{ toJSON: () => ({ type: ComponentType.Container, components: [
  { type: ComponentType.MediaGallery, items: [{ media: { url } }] },
] }) }];

test('uploaded panels accept exact public and ephemeral Discord attachment paths on both CDN hosts', () => {
  assert(messageHasUploadedMedia(panel(`attachment://${name}`), name));
  for (const host of ['cdn.discordapp.com', 'media.discordapp.net']) {
    for (const path of ['attachments', 'ephemeral-attachments']) {
      const url = `https://${host}/${path}/${ids}/${name}?ex=1&is=2`;
      assert(messageHasUploadedMedia(panel(url), name), url);
    }
  }
});

test('uploaded panel CDN matching rejects wrong hosts, schemes, ports, snowflakes and filenames', () => {
  for (const path of ['attachments', 'ephemeral-attachments']) {
    const url = `https://cdn.discordapp.com/${path}/${ids}/${name}`;
    for (const bad of [url.replace('https:', 'http:'), url.replace('.com/', '.com:8443/'),
      url.replace('.com/', '.com:443/'), url.replace('.com/', '.com.evil.example/'),
      url.replace('cdn.discordapp.com', 'evil.example'), url.replace(ids, '123/456'),
      url.replace(ids, `12345678901234567/123456789012345678901`),
      url.replace(name, 'other.mp4'), url.replace(name, `prefix-${name}`),
      url.replace(name, `${name}/extra`), url.replace(`/${path}/`, '/other/'),
      url.replace(name, `nested/${name}`)]) {
      assert.equal(messageHasUploadedMedia(panel(bad), name), false, bad);
    }
  }
});
