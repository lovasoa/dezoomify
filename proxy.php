<?php
header("Access-Control-Allow-Origin: *");
$url = get_magic_quotes_gpc() ? stripslashes($_GET['url']) : $_GET["url"];
if (strpos($url, "http") !== 0) die("Only http requests are allowed.");

$opts = array(
  'http'=>array(
    'header'=>"User-Agent: Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0.2214.85 Safari/537.36\r\n" .
              "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n" .
              "Accept-Language: en-US,en;q=0.5"
    ),
    "ssl"=>array(
        "verify_peer"=>false,
        "verify_peer_name"=>false,
        "crypto_method" => STREAM_CRYPTO_METHOD_TLSv1_0_CLIENT
    )
);
$context = stream_context_create($opts);
readfile($url, false, $context);
?>
