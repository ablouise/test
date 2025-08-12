export function generateProjectId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `project-${crypto.randomUUID()}`;
  }

  const randomId = Math.random().toString(36).substring(2) + Date.now().toString(36);

  return `project-${randomId}`;
}
