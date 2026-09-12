// Public read-only probe. Never connects to WhatsApp or touches production state.
import { Store } from '../src/store.js';
import { fetchResetPosts, resetRelated } from '../src/reset-watch.js';
const store = new Store(':memory:');
try {
  const posts = await fetchResetPosts({ store, log: (event, fields) => console.log(JSON.stringify({ event, ...fields })) });
  console.log(JSON.stringify({ posts: posts.length, unique: new Set(posts.map(post => post.id)).size,
    matching: posts.filter(post => resetRelated(post.text)).length,
    latestPublishedAt: posts.length ? new Date(Math.max(...posts.map(post => post.publishedAt))).toISOString() : null }));
  if (['recent', 'status', 'history'].some(name => !store.get(`resetSource:${name}`)?.ok)) process.exitCode = 1;
} finally { store.close(); }
