//var PHPSCRIPT = "http://ophir.alwaysdata.net/dezoomify/dezoomify.php" //Use a remote php script if you can't host PHP
var PHPSCRIPT = "dezoomify.php"

function dezoomify() {
  //Fetches some informations about the image, and then draw it
  var url = encodeURIComponent(document.getElementById("url").value);
  var xhr = new XMLHttpRequest();

  xhr.onreadystatechange = function () {
    updateProgress(25 * xhr.readyState, "Requesting informations about the image.");
    if (xhr.readyState == 4) {
      if (xhr.status == 200) {
        var xml = xhr.responseXML;
        path = xml.firstChild.getAttribute("path");

        var infos = xml.getElementsByTagName("IMAGE_PROPERTIES")[0];
        if (!infos) {
          document.getElementById("error").style.display = "block";
          console.log(xhr.responseText);
        }
        width = parseInt(infos.getAttribute("WIDTH"));
        height = parseInt(infos.getAttribute("HEIGHT"));
        tileSize = parseInt(infos.getAttribute("TILESIZE"));
        numTiles = parseInt(infos.getAttribute("NUMTILES"));

        remove(document.forms[0]);
        drawImage();
      } else {
        error = document.getElementById("error");
        error.innerHTML = "Error : Unable to join the server. Error code " + xhr.status;
        error.style.display = "block";
      }
    }
  };

  xhr.open("GET", PHPSCRIPT + "?url=" + url, true);
  xhr.send(null);
}

function remove(el) {
  el.parentNode.removeChild(el);
}

function addTile(url, x, y) {
  //Demande une partie de l'image au serveur, et l'affiche lorsqu'elle est reçue
  var i = document.createElement("img");
  i.onload = function () {
    ctx.drawImage(i, x, y);
    loaded++;
  }
  i.src = url;
}

function  updateProgress (percent, text) {
  document.getElementById("percent").innerHTML = text + ' (' + parseInt(percent) + ") %";
  document.getElementById("progressbar").style.width = percent + "%";
}

function loadEnd() {
  //Fonction appelée lorsque l'image est entièrement chargée
  clearInterval(timer);
  var status = document.getElementById("status");
  status.parentNode.removeChild(status);
}

function changeSize() {
  //Ajuste la taille de l'image, pour qu'elle soit en taille de base, ou ajustée à la largeur ou la hauteur de la page
  if (typeof(fit) == "undefined") {
    //Fit page width
    fit = "width";
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerWidth / width * height + "px";
  } else if (fit == "height") {
    //Max zoom
    fit = undefined;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
  } else if (fit == "width") {
    //Fit page height
    fit = "height";
    canvas.style.height = window.innerHeight + "px";
    canvas.style.width = window.innerHeight / height * width + "px";
  }
}

function findZoom(size) {
  /*Retourne le zoomlevel maximum
  Chaque zoomlevel multiplie la taille de l'image par deux. Le zoomlevel 0 correspond à l'image entière contenue dans une seule tile
  On a donc la formule suivante, où size=max(originalWidth, originalHeight) et numTilesAtThisZoomLevel = max(width in tiles, height in tiles) at this zoomlevel :
  size / 2^(maxZoomLevel - zoomlevel) = numTilesAtThisZoomLevel * tileSize
  On sait que pour zoomlevel=0, numTilesAtThisZoomLevel=1
  On peut donc résoudre l'équation, et trouver maxZoomLevel :*/
  return Math.ceil(Math.log(size/tileSize) / Math.log(2));
}

function drawImage() {
  //Tout le code. On devrait peut-être le couper en plusieurs fonctions
  updateProgress(0, "Preparing tiles load...");

  canvas = document.createElement("canvas");
  ctx = canvas.getContext("2d");

  canvas.width = width;
  canvas.height = height;

  canvas.onclick = changeSize;
  document.getElementById("dezoomifiedImage").appendChild(canvas);

  changeSize("width");

  console.log("Taille  de l'image: " + width + "x" + height);
  console.log((width > height) ? findZoom(width) : findZoom(height));

  zoom = (width > height) ? findZoom(width) : findZoom(height);

  var nbrTilesX = Math.ceil(width / tileSize);
  var nbrTilesY = Math.ceil(height / tileSize);

  loaded = 0;
  totalTiles = nbrTilesX * nbrTilesY; //Total number of tiles to load

  var skippedTiles = numTiles - totalTiles;

  for (var y = 0; y < nbrTilesY; y++) {
    for (var x = 0; x < nbrTilesX; x++) {

	  var tileGroup = Math.floor(skippedTiles / 256);
      skippedTiles++;

      var url = path + "/TileGroup" + tileGroup + "/" + zoom + "-" + x + "-" + y + ".jpg";
      addTile(url, x * tileSize, y * tileSize);
    }
  }

  timer = setInterval(function () {
    /*Update the User Interface each 500ms, and not in addTile, because it would
    slow down the all process to update the UI too often.*/
    updateProgress(100 * loaded / totalTiles, "Loading the tiles...");

    if (loaded == totalTiles) {
      loadEnd();
    }
  }, 500);
}
