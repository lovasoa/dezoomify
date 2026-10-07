// German message dictionary for the shared UI.
//
// Translation of `../i18n.ts`, key for key: every English key has exactly one German
// entry with identical `{placeholders}`. Missing keys fall back to English at
// lookup time, so this table must never drop a key when English grows.
// Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub Releases",
// "GPL", "PNG", "JPEG", "URL", "CLI", "FAQ") stay literal.
//
// Erasable-syntax-only TypeScript (plain object, no enums) so node can
// type-strip it directly in tests.

export const de = {
  "view.diagnostics.signedInNote":
    "Wenn Sie sich auf dieser Website anmelden müssen, können diese Details sensible Informationen enthalten. Prüfen Sie sie vor dem Teilen.",
  "view.diagnostics.save": "Diagnosebericht speichern",
  "view.diagnostics.copyFailed":
    "Kopieren fehlgeschlagen. Markieren und kopieren Sie die Details unten.",
  "view.diagnostics.loadFailed":
    "Der vollständige Bericht konnte nicht gelesen werden. Die verfügbaren Details stehen unten.",
  "desktop.done.title": "Bild gespeichert",
  "desktop.done.partial": "Bild mit Lücken gespeichert",
  "desktop.done.size": "{width} × {height} Pixel",
  "desktop.done.saved": "Im gewählten Ordner gespeichert.",
  "desktop.done.open": "Bild öffnen",
  "desktop.done.reveal": "Im Ordner anzeigen",
  "desktop.done.openError":
    "Das Bild konnte nicht geöffnet werden. Prüfen Sie, ob ein Standard-Bildbetrachter installiert ist.",
  "desktop.done.folderError":
    "Der Ordner konnte nicht geöffnet werden. Prüfen Sie, ob ein Dateimanager installiert ist.",
  "desktop.done.missingError": "Das gespeicherte Bild oder der Ordner ist nicht mehr vorhanden.",
  "view.partial.title": "Das Bild ist unvollständig",
  "view.partial.summary": "{done} von {total} Fragmenten wurden abgerufen.",
  "view.partial.gaps":
    "Das gespeicherte Bild wird Lücken haben. Es wurde noch keine Datei gespeichert.",
  "view.partial.refused":
    "Die Website hat die restlichen Fragmente verweigert. Das gespeicherte Bild wird Lücken haben.",
  "view.partial.save": "Unvollständiges Bild speichern",
  "view.partial.cancel": "Abbrechen",
  "view.partial.retry": "Fehlgeschlagene Fragmente erneut abrufen",
  "view.partial.accessDenied": "Die Website hat den Zugriff auf dieses Bild verweigert",
  "view.partial.empty": "Das Bild konnte nicht abgerufen werden",
  "view.partial.noneSaved":
    "Kein Teil des Bildes konnte abgerufen werden. Es wurde keine Datei gespeichert.",
  "view.partial.checkSource":
    "Öffnen Sie die Quellseite und prüfen Sie, ob deren Bildbetrachter funktioniert.",
  "view.partial.openSource": "Quellseite öffnen",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Verstanden",
  "view.modal.closeDialog": "Dialog schließen",
  "view.modal.closeTitle": "Schließen",
  // Desktop-app guidance modal.
  "view.desktop.title": "Dezoomify Desktop-App",
  "view.desktop.subtitle":
    "Leistungsstarke native Anwendung für gigapixelgroße Museumsbilder und lokale Scans",
  "view.desktop.installer": "Das unsignierte {installer} für {platform} ist verfügbar auf",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.releasesNote": "Keine automatischen Updates; prüfen Sie GitHub Releases manuell.",
  "view.desktop.installerMsi": ".msi-Installationsprogramm",
  "view.desktop.installerDmg": ".dmg für Apple silicon",
  "view.desktop.installerDeb": ".deb-Installationsprogramm",
  "view.desktop.installerGeneric": "Installationsprogramm",
  "view.desktop.platformGeneric": "Ihre Plattform",
  "view.desktop.whyTitle": "Warum die Desktop-App verwenden?",
  "view.desktop.why1Title": "Bewältigt größere Kunstwerke:",
  "view.desktop.why1Body":
    "Ein Browser-Tab kann nur eine begrenzte Bildmenge halten. Die Desktop-App setzt das Bild im Speicher zusammen, soweit Speicher verfügbar ist, und schreibt das fertige Ergebnis auf die Festplatte.",
  "view.desktop.why2Title": "Speichert das fertige Bild:",
  "view.desktop.why2Body":
    "Jeder Auftrag wird in genau eine Ausgabedatei auf Ihrem Rechner gespeichert.",
  "view.desktop.why3Title": "Wenn die Website nicht fertig wird:",
  "view.desktop.why3Body":
    "Die Website bricht den Auftrag mit einem Fehler ab und verweist für das vollständige Bild auf die Desktop-App.",
  "view.desktop.howTitle": "So verwenden Sie sie",
  "view.desktop.step1":
    "Laden Sie das unsignierte {installer} für {platform} von unserer GitHub-Releases-Seite herunter und installieren Sie es. Es gibt keine automatischen Updates.",
  "view.desktop.step2":
    "Starten Sie Dezoomify und fügen Sie die Adresse Ihres zoombaren Bildes oder Manifests ein.",
  "view.desktop.step3":
    "Wählen Sie die gewünschte Auflösung und den Zielordner, um das vollständige zusammengesetzte Bild zu speichern.",
  "view.desktop.cliTitle": "Automatisierung gesucht? Nutzen Sie Dezoomify CLI",
  "view.desktop.cliDesc":
    "Das CLI ermöglicht kopfloses, skriptfähiges Speichern einzelner Aufträge, ideal für automatisierte Abläufe und Server ohne Anzeige.",
  "view.desktop.cliLink": "CLI von GitHub Releases laden",
  // Browser-extension guidance modal.
  "view.ext.title": "Dezoomify Browser-Erweiterung",
  "view.ext.subtitle":
    "Automatische Viewer-Erkennung für passwortgeschützte digitale Archive und komplexe Seiten",
  "view.ext.availableOn": "Verfügbar auf",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Warum die Browser-Erweiterung verwenden?",
  "view.ext.why1Title": "Angemeldete Seiten:",
  "view.ext.why1Body":
    "Während Sie ein zoombares Bild betrachten, findet sie automatisch das Bild hinter dem Viewer, auch auf Seiten, auf denen Sie angemeldet sind, etwa Bibliotheksportale, Museumsabos und wissenschaftliche Archive.",
  "view.ext.why2Title": "Einfach zu bedienen:",
  "view.ext.why2Body":
    "Drücken Sie die Dezoomify-Schaltfläche in der Symbolleiste und wählen Sie das zu speichernde Bild, oder senden Sie den Auftrag an die Desktop-App, wenn das Bild sehr groß ist.",
  "view.ext.why3Title": "Privat:",
  "view.ext.why3Body":
    "Sie betrachtet nur die Seite, auf die Sie gezeigt haben, und erst nachdem Sie die Schaltfläche gedrückt haben. Sie beobachtet Ihr Surfen nicht im Hintergrund.",
  "view.ext.howTitle": "So verwenden Sie sie in 3 Schritten",
  "view.ext.step1":
    "Installieren Sie die Erweiterung aus dem Chrome Web Store oder von Firefox Browser Add-ons.",
  "view.ext.step2":
    "Öffnen Sie die Museums- oder Bibliotheksseite mit Ihrem Kunstwerk und melden Sie sich bei Bedarf an.",
  "view.ext.step3":
    "Klicken Sie auf das Dezoomify-Symbol in der Symbolleiste, um das vollaufgelöste Bild automatisch zu erkennen und zu speichern!",
  // Access request (browser-session file access), shared access-request.tsx.
  "view.access.title": "Zugriff erlauben, um fortzufahren",
  "view.access.usesOrigin": "Dieses Bild verwendet Dateien von {origin}.",
  "view.access.needAccess":
    "Dezoomify braucht Zugriff, um diese Dateien zu lesen und Ihr Bild in diesem Browser zusammenzusetzen.",
  "view.access.requesting": "Zugriff wird angefordert…",
  "view.access.allow": "Zugriff erlauben und fortfahren",
  // Idle input section.
  "view.idle.clearTitle": "Eingabe löschen",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Zoombares Bild wird gesucht…",
  "view.step.preflighting": "Bildgröße wird geprüft…",
  "view.step.downloading": "Bildfragmente werden gespeichert…",
  "view.step.saving": "Endbild wird zusammengesetzt…",
  "view.step.contactingDetail": "Bildhost wird kontaktiert…",
  // Live job section.
  "view.job.techDetails": "Technische Details und Protokolle",
  "view.job.manyImages": "{count} Bilder",
  "view.job.paused": "Pausiert",
  "view.job.retryingTiles": "{count} Fragmente werden erneut abgerufen…",
  "view.job.waiting": "Warte auf {host}…",
  "view.job.sourceLabel": "Quelle",
  "view.job.pause": "Pause",
  "view.job.resume": "Fortsetzen",
  "view.job.stopReturn": "Stoppen und zum Anfang zurückkehren",
  "view.job.progressValue": "{done} fertig, {active} in Arbeit, {remaining} verbleibend",
  // Display-only section.
  "view.display.title": "Vorschau wird gezeigt, noch nicht gespeichert",
  "view.display.waysTitle": "Wege, dieses Kunstwerk zu speichern",
  "view.display.extTitle": "Anleitung zur Browser-Erweiterung",
  "view.display.extDesc":
    "Für Seiten mit Anmeldung oder Sitzungs-Cookies. Erkennt Viewer auf aktiven Seiten automatisch.",
  "view.display.deskTitle": "Anleitung zur Desktop-App",
  "view.display.deskDescClean":
    "Für ein sauberes Speichern in voller Größe, wenn der Browser das Bild nur zeigen kann.",
  "view.display.startOver": "Von vorn beginnen",
  "view.resolution.notice":
    "Wegen Browser-Beschränkungen wird nicht in maximaler Auflösung geladen. Die Desktop-App entfernt diese Beschränkungen.",
  "view.resolution.sizes": "Speichert mit {selected} Pixeln statt des Maximums {maximum} Pixel.",
  "view.resolution.download": "Desktop-App herunterladen",
  "view.resolution.tryMaximum": "Maximum versuchen",
  "view.resolution.stop": "Stoppen",
  // Completion section.
  "view.done.ready": "Ihr Bild ist bereit.",
  "view.done.readyTitle": "Bereit zum Speichern",
  "view.done.saveNow": "Bild jetzt speichern",
  "view.done.another": "Weiteres Bild dezoomifizieren",
  // Failure section.
  "view.fail.title": "Bild konnte nicht dezoomifiziert werden",
  "view.fail.deskDescLimits":
    "Für Bilder, die die Speichergrenzen des Browsers sprengen, soweit Speicher verfügbar ist. Wird nativ auf Ihrem Rechner verarbeitet.",
  "view.fail.helpTitle": "Hilfe und Adresssuche",
  "view.fail.helpDesc":
    "So finden Sie die Bildadresse auf Museums- und Archivseiten, und was Sie versuchen können, wenn nichts gefunden wird.",
  "view.fail.reportBug": "Fehler auf GitHub melden",
  "view.fail.retry": "Erneut versuchen",
  "view.fail.canvasAllocation":
    "Dieses Bild ist zu groß für diesen Browser-Tab. Die Desktop-App kann es in voller Größe speichern.",
  "view.fail.canvasContext":
    "Dieser Browser-Tab konnte die Bildfläche in dieser Größe nicht erstellen. Die Desktop-App kann es in voller Größe speichern.",
  // Cancelled section.
  "view.cancel.title": "Speichern abgebrochen",
  "view.cancel.message": "Das Speichern des Bildes wurde gestoppt.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} von {total} Fragmenten",
  "view.job.pixelCounts": "{current} von {total}",
  "view.job.pixels": "{count} px",
  "view.job.megapixels": "{count} Mpx",
  "view.job.gigapixels": "{count} Gpx",
  "view.job.preparation": "{percent}% der Pixel vorbereitet. Das Bild wird fertig gespeichert.",
  "view.job.countsActive": "{current} von {total} Fragmenten · {active} in Arbeit",
  // Recent pictures, including unsuccessful attempts.
  "view.history.title": "Letzte Bilder",
  "view.history.empty": "Noch keine Bilder. Gestartete Bilder erscheinen hier.",
  "view.history.localOnly": "Nur auf diesem Gerät behalten.",
  "view.history.clear": "Verlauf löschen",
  "view.history.image": "Bild",
  "view.history.time": "Beginn",
  "view.history.size": "Größe (px)",
  "view.history.status": "Status",
  "view.history.remove": "Entfernen",
  "view.history.removeImage": "{image} aus den letzten Bildern entfernen",
  "view.history.status.started": "Gestartet",
  "view.history.status.completed": "Abgeschlossen",
  "view.history.status.partial": "Mit Lücken",
  "view.history.status.preview": "Nur Vorschau",
  "view.history.status.failed": "Fehlgeschlagen",
  "view.history.status.cancelled": "Abgebrochen",
  "view.history.status.deleted": "Gelöscht",
  "view.history.status.checking": "Datei wird geprüft…",
  "view.history.status.unavailable": "Datei nicht verfügbar",
  "view.history.status.opening": "Wird geöffnet…",
  "view.history.openImage": "{image} öffnen",
  "view.history.openFailed": "Datei konnte nicht geöffnet werden.",
  "view.input.description":
    "Dezoomify lädt zoombare Bilder in Fragmenten aus Bibliotheken, Museen, Galerien und anderen Websites herunter. Fügen Sie unten die Adresse eines Bildes ein, um es herunterzuladen.",
  "view.input.placeholder": "Adresse eines Bildbetrachters oder Manifests einfügen",
  "view.input.aria": "Adresse der Webseite mit dem zoombaren Bild",
  "view.input.start": "Bild finden",
  // Rate-limit explainers (see failure.ts plainMessageFor).
  "view.fail.rateProxy":
    "Die Website, die dieses Bild hostet, begrenzt, wie viele Seiten unser Server bei ihr anfordern darf, und diese Grenze wurde gerade erreicht, daher konnte die Seite nicht geöffnet werden. Die Browser-Erweiterung und die Desktop-App laden über Ihre eigene Verbindung statt über unseren Server und sind von dieser Grenze nicht betroffen.",
  "view.fail.rateDirect":
    "Die Website, die dieses Bild hostet, erhält gerade zu viele Anfragen von Ihrer eigenen Verbindung. Wenige Minuten Wartezeit klären dies meist, und Erweiterung oder Desktop-App sehen bis dahin dasselbe Besetztzeichen.",
  // Fetch-failure family (see failure.ts plainMessageFor).
  "view.fail.httpNotFound":
    "Diese Seite wurde nicht gefunden. Prüfen Sie die Adresse und versuchen Sie es erneut.",
  "view.fail.httpRefused":
    "Die Website hat die Freigabe dieser Datei verweigert (HTTP {http}). Sie blockiert möglicherweise gemeinsam genutzte Server; die Browser-Erweiterung oder die Desktop-App funktionieren möglicherweise trotzdem.",
  "view.fail.httpSiteProblem":
    "Die Website hatte ein Problem beim Öffnen dieser Seite. Versuchen Sie es in Kürze erneut.",
  "view.fail.httpNotOpened":
    "Diese Seite konnte nicht geöffnet werden. Prüfen Sie die Adresse und versuchen Sie es erneut.",
  "view.fail.policyBlocked":
    "Diese Adresse kann über die Website nicht geöffnet werden. {hint} Die Browser-Erweiterung oder die Desktop-App funktionieren möglicherweise trotzdem.",
  "view.fail.hintAddress": "Prüfen Sie die Adresse und versuchen Sie es erneut.",
  "view.fail.hintPrivate": "Die Website kann keine privaten oder lokalen Adressen öffnen.",
  "view.fail.hintContentType":
    "Die Website hat mit einem Dateityp geantwortet, den sie hier nicht prüft.",
  "view.fail.hintRedirect":
    "Die Website hat so umgeleitet, wie es die Website nicht nachvollziehen kann.",
  "view.fail.proxyBudget":
    "Diese Seite ist zum Prüfen hier zu groß. Versuchen Sie es mit der Desktop-App für sehr große Bilder.",
  "view.fail.proxyFetch":
    "Der Metadaten-Proxy konnte diese Adresse nicht abrufen. Versuchen Sie es in Kürze erneut.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid":
    "Bitte geben Sie eine gültige Webadresse ein, die mit http:// oder https:// beginnt",
  "desktop.settings.unusable":
    "Diese Download-Einstellungen können nicht verwendet werden. Passen Sie die markierten Einstellungen an und versuchen Sie es erneut.",
  "desktop.settings.invalidSubmit":
    "Diese Download-Einstellungen sind ungültig. Passen Sie sie an und versuchen Sie es erneut.",
  "desktop.output.deniedPick":
    "Das Speicherziel wurde nicht angenommen. Wählen Sie eine andere Datei, um fortzufahren.",
  "desktop.output.exists":
    "Am Speicherziel von {host} existiert bereits eine Datei. Wählen Sie eine andere Datei oder bestätigen Sie das Überschreiben, um fortzufahren.",
  "desktop.output.destDenied":
    "Das Speicherziel wurde von {host} aus nicht angenommen. Wählen Sie eine andere Datei, um fortzufahren.",
  "desktop.job.gone":
    "Dieser Auftrag ist von {host} aus nicht mehr aktiv. Beginnen Sie erneut mit einer frischen Adresse.",
  "desktop.msg.thisPicture": "dieses Bild",
  "desktop.msg.dimsPixels": "{a} mal {b} Pixel",
  "desktop.msg.needAbout": " Es braucht etwa {need} Speicher",
  "desktop.output.canvasLimit":
    "Dieses Bild ist zu groß, um es auf diesem Rechner zusammenzusetzen ({dims},{need} bei 4 Byte je Pixel, Grenze {limit}). Speichern Sie eine kleinere Fassung mit Max. Breite (CLI: --max-width). Hinweis: JPEG erlaubt höchstens {jpegMax} Pixel je Seite; behalten Sie PNG für größere Bilder. Von {host}.",
  "desktop.output.jpegLimit":
    "Dieses Bild ({dims}) ist zu groß für JPEG, das höchstens {jpegMax} Pixel je Seite erlaubt. Speichern Sie es stattdessen als PNG. Von {host}.",
  "desktop.output.webpLimit":
    "Dieses Bild ({dims}) ist zu groß für WebP, das höchstens {webpMax} Pixel je Seite erlaubt. Speichern Sie es stattdessen als PNG. Von {host}.",
  "desktop.tile.partialDiscarded":
    "Das Teilbild wurde verworfen, sodass keine Datei blieb. Versuchen Sie es von {host} aus mit stabiler Verbindung erneut.",
  "desktop.tile.partialChoice":
    "Einige Teile dieses Bildes von {host} konnten nicht gespeichert werden. Versuchen Sie die fehlenden Teile erneut oder behalten Sie das Teilbild mit leeren Flächen.",
  "view.discovery.none":
    "Unter dieser Adresse wurde kein zoombares Bild gefunden. Versuchen Sie eine Seite mit Betrachter oder die Browsererweiterung.",
  "desktop.plan.none":
    "Dieses Bild hat von {host} aus keine speicherbare Größe. Versuchen Sie ein anderes Bild oder eine kleinere Max. Breite.",
  "desktop.transport.stalled":
    "Speichern stockt beim Kontakt mit {host}. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
  "desktop.output.writeFail":
    "Dieses Bild von {host} konnte nicht geschrieben werden. Wählen Sie ein anderes Speicherziel und versuchen Sie es erneut.",
  "desktop.job.cancelledMsg":
    "Das Speichern des Bildes wurde gestoppt. Jede unfertige Datei wurde entfernt.",
  "desktop.start.failed":
    "Das Speichern dieses Bildes von {host} konnte nicht gestartet werden. Versuchen Sie es erneut.",
  "desktop.choice.failed": "Diese Wahl wurde nicht angenommen. Versuchen Sie es erneut.",
  "desktop.internal.error":
    "Etwas Unerwartetes hat dieses Speichern von {host} gestoppt. Versuchen Sie es erneut und kopieren Sie die Diagnose, falls es erneut geschieht.",
  "desktop.save.fallback":
    "Dieses Bild von {host} konnte nicht gespeichert werden. Versuchen Sie es erneut.",
  "desktop.invoke.startFallback": "Der Auftrag konnte nicht gestartet werden.",
  "desktop.invoke.partial": "Die Teilbildwahl wurde abgelehnt.",
  "desktop.rec.missing": "Fehlende Fragmente: {shown}{rest}.",
  "desktop.rec.more": " und {n} weitere",
  "desktop.rec.keep": "Teilbild behalten",
  "desktop.rec.discard": "Teilbild verwerfen",
  "desktop.rec.retryTiles": "Fehlende Fragmente erneut versuchen",
  "desktop.rec.missingSome": "Einige Fragmente konnten nicht gespeichert werden.",
  "desktop.rec.missingCount": "{count} Fragmente konnten nicht gespeichert werden.",
  "desktop.rec.missingOne": "{count} Fragment konnte nicht gespeichert werden.",
  "desktop.rec.missingList": "{n} fehlende Fragmente: {shown}{rest}.",
  "desktop.rec.missingOneList": "{n} fehlendes Fragment: {shown}{rest}.",
  "desktop.done.partialTitle": "Teilbild gespeichert",
  "desktop.done.partialDesc":
    "Diese Datei ist als Teilbild markiert: {summary} Fehlende Flächen bleiben leer. So unterscheidet sie sich von einem vollständigen Speichern.",
  "desktop.cancel.note":
    "Speichern abgebrochen. Aufgeräumt, und jede unfertige Datei wurde entfernt.",
  "desktop.copy.diagnostics": "Diagnose kopieren",
  "desktop.copy.copied": "Kopiert!",
  "desktop.panel.jobActions": "Desktop-Auftragsaktionen",
  "desktop.settings.reset": "Einstellungen zurücksetzen",
  "desktop.quick.info": "Weitere Informationen",
  "desktop.quick.auto": "Automatisch",
  "desktop.quick.sizeEstimate": "<{size} MB",
  "desktop.quick.folderInfo": "Wählen Sie den Speicherort für heruntergeladene Bilder.",
  "desktop.quick.formatInfo":
    "Wählen Sie ein Ausgabeformat. Automatisch speichert undurchsichtige Bilder bis 65.535 Pixel pro Seite als JPEG, sonst als PNG.",
  "desktop.quick.sizeInfo":
    "Vorgaben wählen die größte Quellstufe innerhalb dieser Maße. Passt keine, wird die kleinste verwendet; sie kann die Vorgaben und Encodergrenzen überschreiten. Bilder werden nicht skaliert. Schätzungen nehmen die angegebenen Maße an; tatsächliche Größe und Formatkompatibilität hängen von der Quelle ab. Geschätzte MB = Breite × Höhe × Byte/Pixel / 1.000.000. PNG: 1,6 Byte/Pixel; verlustfreies WebP: 1,3; TIFF/ZIF: 3. JPEG wurde mit dem nativen Encoder an zwei Gemälden und einer Karte kalibriert: Qualität ≤25: 0,1; ≤50: 0,15; ≤75: 0,2; ≤90: 0,3; ≤95: 0,4; ≤98: 0,45; ≤100: 0,5 Byte/Pixel. Automatisch schätzt ein undurchsichtiges JPEG; Transparenz verwendet PNG. ZIF/IIIF rechnen ein Drittel für Pyramidenstufen hinzu. Jede Schätzung erhält 10 % Reserve und wird dann auf die nächsten 5 MB aufgerundet. Heuristiken, keine garantierten Dateigrößen; Details, Quellkompression, Seitenverhältnis, Metadaten und Encoder-Einstellungen beeinflussen die tatsächliche Größe. Volle/eigene Größen benötigen Quelldimensionen.",
  "desktop.quick.maxWidth": "Max. Breite",
  "desktop.quick.maxHeight": "Max. Höhe",
  "desktop.quick.original": "Original",
  "desktop.quick.userDefined": "Benutzerdefiniert",
  "desktop.quick.estimatedSize": "Geschätzte Größe ({format})",
  "desktop.quick.networkInfo":
    "Schnell nutzt bis zu 16 gleichzeitige Anfragen ohne Drosselung. Ausgewogen startet bis zu 5 Anfragen pro Sekunde, Schonend bis zu 2. Langsameres Tempo kann ausgelasteten Servern helfen.",
  "desktop.quick.source": "Quellabhängig",
  "desktop.quick.exact": "Individuell",
  "desktop.quick.upTo": "Bis zu {size}K",
  "desktop.quick.hint.auto": "adaptiv",
  "desktop.quick.hint.png": "verlustfrei",
  "desktop.quick.hint.jpeg": "komprimiert",
  "desktop.quick.hint.tiff": "Archivierung",
  "desktop.quick.hint.webp": "verlustfrei",
  "desktop.quick.hint.zif": "zoombar",
  "desktop.quick.hint.iiifDir": "gekachelt",
  "desktop.quick.format.auto":
    "JPEG für undurchsichtige Bilder bis 65.535 Pixel pro Seite; PNG bei Transparenz oder größeren Bildern. Die JPEG-Qualität gilt auch für Automatisch.",
  "desktop.quick.format.png":
    "Verlustfreie Pixel und Transparenz; größere Dateien, für die Bearbeitung geeignet.",
  "desktop.quick.format.jpeg":
    "Kleinere verlustbehaftete Dateien. Keine Transparenz; bis 65.535 Pixel pro Seite. Qualität unter Weitere Einstellungen ändern.",
  "desktop.quick.format.tiff": "Verlustfreie Ausgabe zur Archivierung und Bearbeitung.",
  "desktop.quick.format.webp": "Verlustfrei komprimierte Ausgabe bis 16.383 Pixel pro Seite.",
  "desktop.quick.format.zif": "Eine verlustfreie gekachelte TIFF-Pyramide für mehrere Zoomstufen.",
  "desktop.quick.format.iiifDir":
    "Ordner mit JPEG-Kacheln und info.json zum Hosten eines IIIF-Bildes.",
  "desktop.quick.rate.maximum": "16 parallel",
  "desktop.quick.rate.balanced": "5/s",
  "desktop.quick.rate.gentle": "2/s",
  "desktop.quick.folder": "Ordner",
  "desktop.quick.askEachTime": "Jedes Mal fragen",
  "desktop.quick.chosenFolder": "Ausgewählter Ordner",
  "desktop.quick.chooseFolder": "Startordner für den Speicherdialog wählen",
  "desktop.quick.format": "Format",
  "desktop.quick.size": "Größe",
  "desktop.quick.network": "Netzwerk",
  "desktop.quick.fast": "Schnell",
  "desktop.quick.balanced": "Ausgewogen",
  "desktop.quick.gentle": "Schonend",
  "desktop.quick.fullResolution": "Volle Auflösung",
  "desktop.quick.upTo4k": "Bis 4K",
  "desktop.quick.upTo2k": "Bis 2K",
  "desktop.quick.custom": "Benutzerdefiniert…",
  "desktop.quick.more": "Weitere Einstellungen",
  "desktop.advanced.title": "Erweiterte Einstellungen",
  "desktop.advanced.done": "Fertig",
  "desktop.advanced.jpegQuality": "JPEG-Qualität",
  "desktop.advanced.jpegQualityDesc": "Höhere Werte erhalten mehr Bilddetails.",
  "desktop.advanced.compressionEffort": "Kompressionsaufwand",
  "desktop.advanced.compressionEffortDesc":
    "Die Bildqualität bleibt verlustfrei; höhere Werte dauern länger.",
  "desktop.advanced.dimensions": "Eigene Abmessungen",
  "desktop.advanced.dimensionsDesc":
    "Einen Wert leer lassen, um das Originalverhältnis zu bewahren.",
  "desktop.advanced.width": "Breite",
  "desktop.advanced.height": "Höhe",
  "desktop.advanced.retries": "Versuche",
  "desktop.advanced.retriesDesc":
    "Fehlgeschlagene Bildfragmente erneut versuchen, bevor ein Teilergebnis bleibt.",
  "desktop.advanced.resumeCache": "Fortsetzungs-Cache",
  "desktop.advanced.resumeCacheDesc":
    "Fragmente nach einem unterbrochenen Speichern wiederverwenden.",
  "desktop.advanced.choose": "Auswählen…",
  "desktop.advanced.change": "Ändern…",
  "desktop.advanced.headers": "Anfragekopfzeilen",
  "desktop.advanced.headersDesc": "Für geschützte Viewer. Nur an den Bildursprung gesendet.",
  // Extension job-tab user copy, rendered through the same `t(key, vars)`
  // shape; log and diagnostics lines stay literal English and never use these
  // keys. `test/ui-i18n.test.mjs` fails when the page renders a key outside
  // this table.
} as const;
