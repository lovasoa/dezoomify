<?php
header("Access-Control-Allow-Origin: *");
$url = get_magic_quotes_gpc() ? stripslashes($_GET['url']) : $_GET["url"];
if (strpos($url, "http") !== 0) die("Only http requests are allowed.");
readfile($url);
?>
