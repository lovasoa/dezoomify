<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Expose-Headers: X-Set-Cookie");
$url = get_magic_quotes_gpc() ? stripslashes($_GET['url']) : $_GET["url"];
if (preg_match("#^https?://#", $url) !== 1) {
  die("Only http requests are allowed.");
}

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

$last_error = NULL;

// Save errors
set_error_handler(function($errno, $errstr, $errfile, $errline, $errcontext) {
  global $last_error;
  $last_error = new ErrorException($errstr, 0, $errno, $errfile, $errline);
});
$f = fopen($url, 'r', false, $context);
restore_error_handler();

if (false !== $f) {

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
  /// Unable to open the connection
  http_response_code(500);
  header("Content-Type: application/json");
  $trace = $last_error->getTrace();
  echo json_encode(array(
    "error" => $last_error->getMessage(),
    "code" => $last_error->getCode(),
    "trace" => $last_error->getTraceAsString(),
  ));
}

