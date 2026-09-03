(function () {
  var API_URL = "https://api.github.com/repos/brsloan/lastmilepdf/releases/latest";
  var RELEASES_URL = "https://github.com/brsloan/lastmilepdf/releases/latest";

  var winBtn = document.getElementById("dl-windows");
  var winPortableBtn = document.getElementById("dl-windows-portable");
  var linuxBtn = document.getElementById("dl-linux");
  var statusEl = document.getElementById("release-status");

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function findAsset(assets, test) {
    for (var i = 0; i < assets.length; i++) {
      if (test(assets[i].name)) return assets[i];
    }
    return null;
  }

  fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } })
    .then(function (res) {
      if (!res.ok) throw new Error("bad response");
      return res.json();
    })
    .then(function (release) {
      var assets = release.assets || [];
      var tag = release.tag_name || "";

      var setupExe = findAsset(assets, function (n) {
        return /Setup.*\.exe$/i.test(n);
      });
      var portableExe = findAsset(assets, function (n) {
        return /portable\.exe$/i.test(n);
      });
      var appImage = findAsset(assets, function (n) {
        return /\.AppImage$/i.test(n);
      });

      if (setupExe && winBtn) {
        winBtn.href = setupExe.browser_download_url;
      }
      if (portableExe && winPortableBtn) {
        winPortableBtn.href = portableExe.browser_download_url;
      }
      if (appImage && linuxBtn) {
        linuxBtn.href = appImage.browser_download_url;
      }

      setStatus(
        (tag ? tag + " — " : "") +
          "installers are unsigned, see notes below. macOS is not packaged yet."
      );
    })
    .catch(function () {
      setStatus("Couldn't reach GitHub automatically — use the link below to grab the latest build.");
    });
})();
