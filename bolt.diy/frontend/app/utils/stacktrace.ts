/**
 * Cleans container URLs from stack traces to show relative paths instead
 */
/**
 * Cleans Docker container URLs from stack traces to show relative paths instead
 */
export function cleanStackTrace(stackTrace: string, workDir = '/app'): string {
  // Function to clean a single path
  const cleanPath = (path: string): string => {
    // Handle Docker container absolute paths
    if (path.startsWith(workDir)) {
      return path.slice(workDir.length).replace(/^\//, '');
    }

    // Handle localhost URLs with Docker ports
    const urlMatch = path.match(/^https?:\/\/localhost:\d+\/(.*)$/);

    if (urlMatch) {
      return urlMatch[1];
    }

    // Return unchanged if not a Docker path
    return path;
  };

  // Patterns to match in stack traces
  const patterns = [
    // Docker container paths (e.g., /app/src/index.js)
    new RegExp(`${workDir}/([^\\s:)]+)`, 'g'),

    // Localhost URLs (e.g., http://localhost:3000/src/index.js)
    /https?:\/\/localhost:\d+\/([^\s)]+)/g,

    // Webpack compiled paths (e.g., webpack:///./src/index.js)
    /webpack:\/\/\/\.\/([^\s)]+)/g,
  ];

  // Process each line of the stack trace
  return stackTrace
    .split('\n')
    .map((line) => {
      // Apply each pattern to the line
      for (const pattern of patterns) {
        line = line.replace(pattern, (match, path) => cleanPath(path || match));
      }
      return line;
    })
    .join('\n');
}
