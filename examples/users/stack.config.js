export default {
  frontend: {
    framework: "react",
    frameworkVersion: "18.3.1",
    ui: "antd",
    uiVersion: "5.24.7",
    language: "typescript",
    languageVersion: "5.8.2",
    nodeVersion: "20",
    packageManager: "npm",
    host: "0.0.0.0",
    port: 3100,
    apiBasePath: "/api",
    proxyTarget: "http://127.0.0.1:5100",
    dependencies: {
      antd: "^5.24.7",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
      "react-router-dom": "^6.30.1",
      axios: "^1.8.4"
    }
  },
  backend: {
    framework: "flask",
    frameworkVersion: "3.0",
    language: "python",
    languageVersion: "3.11",
    host: "127.0.0.1",
    port: 5100,
    entry: "app.py",
    corsOrigins: ["http://localhost:3100", "http://127.0.0.1:3100"],
    dependencies: {
      Flask: "Flask>=3.0,<3.1",
      "Flask-Cors": "Flask-Cors>=4.0,<5.0"
    }
  },
  data: {
    engine: "mongodb",
    engineVersion: "7",
    uri: "mongodb://127.0.0.1:27017/specos_users",
    database: "specos_users",
    dependencies: {
      pymongo: "pymongo>=4.6,<5.0"
    }
  }
};
