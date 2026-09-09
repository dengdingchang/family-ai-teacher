(() => {
  const el = id => document.getElementById(id);
  const form = el("modelForm");
  if (!form) return;
  let saved = null;
  let busy = false;
  const status = text => { el("modelSaveStatus").textContent = text; };
  function fill(value) {
    saved = value;
    el("modelProvider").value = value.provider;
    el("modelBaseUrl").value = value.base_url;
    el("modelName").value = value.model;
    el("modelTimeout").value = value.timeout_seconds;
    el("searchProvider").value = value.search_provider;
    el("imageProvider").value = value.image_provider || "codex";
    el("modelKey").value = "";
    el("modelKey").placeholder = value.api_key_configured ? "已配置；留空保留（换地址需填新密钥）" : "填写此服务的 API 密钥";
    el("modelBaseUrl").readOnly = value.provider === "openai";
  }
  async function request(path, body) {
    const response = await fetch(path, body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {});
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : "操作失败，请检查设置");
    return value;
  }
  el("modelPanel").addEventListener("toggle", async () => {
    if (!el("modelPanel").open || saved || busy) return;
    busy = true;
    try { fill(await request("/api/parent/models")); status("当前设置已载入"); }
    catch (error) { status(error.message); }
    finally { busy = false; }
  });
  el("modelProvider").addEventListener("change", () => {
    const openai = el("modelProvider").value === "openai";
    el("modelBaseUrl").readOnly = openai;
    el("modelBaseUrl").value = openai ? "https://api.openai.com/v1" : saved?.base_url || "";
    el("modelName").value = openai ? "gpt-5.6-sol" : saved?.model || "";
    el("modelKey").value = "";
    status(openai ? "需填写 OpenAI API 密钥。可先测试；测试会发一条不含家庭资料的短请求。" : "请确认服务地址与模型名称。");
  });
  function values() {
    return {provider:el("modelProvider").value, base_url:el("modelBaseUrl").value,
      model:el("modelName").value, api_key:el("modelKey").value,
      timeout_seconds:Number(el("modelTimeout").value), search_provider:el("searchProvider").value,
      image_provider:el("imageProvider").value,
      revision:saved?.revision};
  }
  async function submit(test) {
    if (busy || !saved || !form.reportValidity()) return;
    busy = true;
    const controls = [...form.querySelectorAll("input,select,button")];
    const body = values();
    controls.forEach(control => { control.disabled = true; });
    status(test ? "正在测试这个模型…" : "正在保存…");
    try {
      const result = await request(`/api/parent/models${test ? "/test" : ""}`, body);
      if (test) status(`连接成功，${result.model} 已回答，用时 ${result.latency_s} 秒。尚未保存。`);
      else { fill(result); status("已保存并应用，下一次请求使用新设置。"); }
    } catch (error) { status(error.message); }
    finally { busy = false; controls.forEach(control => { control.disabled = false; }); }
  }
  form.addEventListener("submit", event => { event.preventDefault(); void submit(false); });
  el("testModel").addEventListener("click", () => { void submit(true); });
})();
