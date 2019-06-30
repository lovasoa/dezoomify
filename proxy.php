<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Expose-Headers: X-Set-Cookie");
$url = get_magic_quotes_gpc() ? stripslashes($_GET['url']) : $_GET["url"];
if (strpos($url, "http") !== 0) die("Only http requests are allowed.");

$headers =
  "User-Agent: Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0.2214.85 Safari/537.36" .
  "\r\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" .
  "\r\nAccept-Language: en-US,en;q=0.5" . 
  "\r\nReferer: $url";

if (isset($_GET["cookies"])) {
  $headers .= "\r\nCookie: " . str_replace("\n", "", $_GET["cookies"]);
}

$opts = array(
  "http" => array(
    "header" => $headers
  ),
  "ssl" => array(
    "verify_peer"=>false,
    "verify_peer_name"=>false,
  )
);
$context = stream_context_create($opts);
if (false !== ($f = fopen($url, 'r', false, $context))) {

  // Header management
  $meta = stream_get_meta_data($f);
  $cookies = "";
  foreach($meta['wrapper_data'] as $header) {
    if (preg_match("/Set-Cookie:\s*([^;]+)/i", $header, $m)) {
      $cookies .= $m[1] . ';';
    } else if (strpos($header, "Content-Type:") === 0) {
      header($header);
    }
  }
  // Javascript cannot access cookies directly, so we change the header name
  if ($cookies !== "") header("X-Set-Cookie: " . $cookies);

  // Pipe the stream from the webpage to our output
  stream_copy_to_stream($f, fopen("php://output", 'w'));
  fclose($f);
} else {
  http_response_code(500);
}

