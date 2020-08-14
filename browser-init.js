(function () {
  document.getElementById("urlform").onsubmit = function (evt) {
    evt.preventDefault();
    var url = document.getElementById("url").value;
    window.location.hash = url;
    ZoomManager.open(url);
    return false;
  }

  // allow to set the URL to be dezoomed by setting the URL hash
  var startURL = window.location.hash.slice(1);
  if (startURL) {
    document.getElementById("url").value = startURL;
  }

  document.querySelector("#popup > button[title=Close]").addEventListener("click", function () {
    document.getElementById("popup").style.bottom = "-500px";
  })
})();
