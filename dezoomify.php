<?php
/*
    This file is part of Dezoomify.

    Dezoomify is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Dezoomify is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with Dezoomify.  If not, see <http://www.gnu.org/licenses/>.

This script extracts the ImageProperties.xml file from the webpage specified by the GET parameter "url".
*/

//Allow cross-domain requests on this script. This allows people to host only the JS + HTML part of the script, and use an other server to get the image properties from the web.
header("Access-Control-Allow-Origin: *");

ini_set("display_errors",0);//Comment this line to debug the script

function url_to_absolute ($url, $path) {
//Returns the absolute path to an URL and a path

	//If the path is in fact an url, return it
	if (preg_match("#^[a-zA-Z0-9]+://#i", $path)) return $path;
	
	if ($path[0] == '/'){//If the path is relative to the base server
		return preg_replace ("#([a-zA-Z0-9]+://[^/]+)(/.*)?#i", "$1/".$path, $url);

	}else {
		return preg_replace ("#([a-zA-Z0-9]+://[^/]+(/[^$\.\?&]*)?)(/.*?)?$#i", "$1/".$path, $url);
	}
}

function zoomifyPath ($url){
//Extract the path to the zoomify folder from any page containing a Zoomify viewer	
	$html = file_get_contents($url);
	if ($html === FALSE){//If an error occured
		return $url;//We assume that the provided url was the zoomifyImagePath
	}

	/*First test if the webpage contains a Zoomify flash player.
	We search a string of the form zomifyImagePath=sth*/
	preg_match ( '/zoomifyImagePath=([^\'"&]*)[\'"&]/i', $html , $addr );

	/*If no flash player was found, search a Zoomify HTML5 player.
	The searched url is within a javascript script. It's the second argument of the showImage function.*/
	if (count($addr)===0)
  	preg_match("#showImage\([^),]*,[^\"']*[\"']([^'\"]*)[^)]*\)#", $html, $addr);
	
	//var_dump($addr);
	return url_to_absolute ($url, $addr[1]);
}

if (isset($_GET['url'])){
	$url = addslashes(rawurldecode($_GET['url']));
	$path = zoomifyPath ($url);
}elseif (isset($_GET["path"])){
	$path=addslashes(rawurldecode($_GET["path"]));
}else {
	echo "<form method='get' action='dezoomify.php'>
			<p>
				<label for='url'>URL of the webpage containing a Zoomify viewer :</label>
				<input type='text' name='url' id='url' size='100' />
				<input type='submit' />

			</p>";
	exit();
}


$xml = file_get_contents($path."/ImageProperties.xml");

header('Content-Type: text/xml');//The script returns xml and not html
echo "<?xml version=\"1.0\"?>\n";
echo "
<infos path='$path'>
	$xml
</infos>
";
?>
