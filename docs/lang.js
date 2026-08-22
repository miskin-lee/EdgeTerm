(function () {
  var btn = document.getElementById('langBtn');
  function apply(lang) {
    document.body.setAttribute('data-lang', lang);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    btn.textContent = lang === 'zh' ? 'EN' : '中文';
    try { localStorage.setItem('edgeterm-lang', lang); } catch (e) {}
  }
  var saved = null;
  try { saved = localStorage.getItem('edgeterm-lang'); } catch (e) {}
  apply(saved || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en'));
  btn.addEventListener('click', function () {
    apply(document.body.getAttribute('data-lang') === 'zh' ? 'en' : 'zh');
  });
})();
