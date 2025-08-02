import { type LoaderFunctionArgs } from '@remix-run/cloudflare';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const editorOrigin = url.searchParams.get('editorOrigin') || 'https://stackblitz.com';
  console.log('editorOrigin', editorOrigin);

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Connect to Docker</title>
      </head>
      <body>
        <script type="module">
          (async () => {
            // Initialize Docker connection
            const dockerSocketUrl = 'ws://localhost:3001/ws';
            
            const socket = new WebSocket(dockerSocketUrl);
            
            socket.onopen = () => {
              console.log('Connected to Docker service');
              window.parent.postMessage({
                type: 'docker-connected',
                status: 'ready'
              }, '${editorOrigin}');
            };

            socket.onmessage = (event) => {
              window.parent.postMessage({
                type: 'docker-message',
                data: event.data
              }, '${editorOrigin}');
            };

            window.addEventListener('message', (event) => {
              if (event.origin !== '${editorOrigin}') return;
              
              if (event.data.type === 'docker-command') {
                socket.send(JSON.stringify(event.data.command));
              }
            });
          })();
        </script>
      </body>
    </html>
  `;

  return new Response(htmlContent, {
    headers: { 'Content-Type': 'text/html' },
  });
};
