Object.assign(process.env, {
  NODE_ENV: "test",
  LOCAL_MODE: "true",
  LLM_PROVIDER: "mrie",
  STT_PROVIDER: "browser",
  TTS_PROVIDER: "browser",
});
