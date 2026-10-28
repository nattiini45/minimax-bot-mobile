// AsyncStorage v3 does not ship a jest mock, so the app's persistence is stubbed here.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    __esModule: true,
    default: {
      getItem: async (key) => (store.has(key) ? store.get(key) : null),
      setItem: async (key, value) => {
        store.set(key, value);
      },
      removeItem: async (key) => {
        store.delete(key);
      },
      clear: async () => {
        store.clear();
      },
    },
  };
});
