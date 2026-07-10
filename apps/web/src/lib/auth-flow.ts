export async function logoutAndClear(logoutRequest: () => Promise<void>, clear: () => void): Promise<void> {
  try {
    await logoutRequest();
  } finally {
    clear();
  }
}
