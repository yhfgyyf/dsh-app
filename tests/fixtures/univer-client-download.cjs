const clientUrl = 'https://unpkg.com/dsh-univer-office@0.3.2/lib/client.js';

// CDN preparation is independent of the UI acceptance test. Retry only transient
// transport/server failures; the caller still checks the exact bytes and SHA-256.
async function downloadClient(fetchClient = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchClient(clientUrl, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (response.status !== 200) {
        await response.body?.cancel();
        const error = new Error('Pinned npm client download failed: ' + response.status);
        error.retryable = [408, 429].includes(response.status) || response.status >= 500 && response.status < 600;
        throw error;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      const transient = error.retryable === true || error instanceof TypeError || error.name === 'TimeoutError';
      if (!transient || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}

module.exports = { clientUrl, downloadClient };
if (require.main === module) downloadClient().then(bytes => process.stdout.write(bytes)).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
