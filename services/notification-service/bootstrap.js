if (process.env.SECRETS_JSON) {
  for (const [key, value] of Object.entries(JSON.parse(process.env.SECRETS_JSON))) {
    process.env[key] = value;
  }
}
