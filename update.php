<?php 
header('Content-Type: text/plain; charset=utf8');
system("git pull --verbose 2>&1");
?>