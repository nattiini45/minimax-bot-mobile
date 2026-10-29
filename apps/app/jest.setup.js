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

// The keystore is a native module, so it is stubbed here as well. The stub keeps
// its items apart from AsyncStorage's, because that is the whole point of it: the
// token must not turn up in the plain store.
jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    __esModule: true,
    isAvailableAsync: async () => true,
    setItemAsync: async (key, value) => {
      store.set(key, value);
    },
    getItemAsync: async (key) => (store.has(key) ? store.get(key) : null),
    deleteItemAsync: async (key) => {
      store.delete(key);
    },
  };
});
