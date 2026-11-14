// Link releases the child only after assigning it to its Windows Job Object.
const command = await new Promise((resolve, reject) => {
  process.stdin.once('data', resolve);
  process.stdin.once('end', () => reject(new Error('Agent Link parent closed before startup')));
  process.stdin.once('error', reject);
});
process.stdin.pause();
if (String(command).trim() !== 'start') throw new Error('Invalid Agent Link startup command');
