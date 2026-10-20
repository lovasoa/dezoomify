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
  "view.images.title": "Bild auswählen",
  "view.images.untitled": "Bild {number}",
  "view.images.noPreview": "Keine Vorschau verfügbar",
  "view.images.unknownSize": "Abmessungen unbekannt",
  "view.images.choose": "Auswählen",
  "view.images.chooseNamed": "{title} auswählen (Bild {number})",
  "view.images.cancel": "Abbrechen",
  "page.brand": "Zoombare Bilder speichern",
  "page.nav.label": "Hauptnavigation",
  "page.nav.extension": "Browser-Erweiterung",
  "page.nav.desktop": "Desktop-App",
  "page.nav.help": "Hilfe",
  "page.nav.donate": "Spenden",
  "page.nav.donateTitle": "Zu den Hostingkosten beitragen",
  "page.footer.source": "Quellcode (GPL)",
  "page.footer.faq": "Häufige Fragen",
  "page.footer.privacy": "Datenschutz",
  "page.footer.terms": "Nutzungsbedingungen",
  "page.legacy.title": "Suchen Sie das bisherige Dezoomify?",
  "page.legacy.link": "Alte Version öffnen",
  "page.preview.zoomOut": "Verkleinern",
  "page.preview.zoomIn": "Vergrößern",
  "page.preview.reset": "Zoom auf 100 Prozent zurücksetzen",
  "page.preview.fit": "Einpassen",
  "page.preview.fitLabel": "Bild in die Vorschau einpassen",
  "view.diagnostics.signedInNote":
    "Wenn Sie sich auf dieser Website anmelden müssen, können diese Details sensible Informationen enthalten. Prüfen Sie sie vor dem Teilen.",
  "view.diagnostics.save": "Diagnosebericht speichern",
  "view.diagnostics.copyFailed":
    "Kopieren fehlgeschlagen. Markieren und kopieren Sie die Details unten.",
  "view.diagnostics.loadFailed":
    "Der vollständige Bericht konnte nicht gelesen werden. Die verfügbaren Details stehen unten.",
  "view.retry.title": "Download angehalten",
  "view.retry.summary": "{done} von {total} Bildstücken wurden heruntergeladen.",
  "view.retry.explanation":
    "Die automatischen Versuche sind ausgeschöpft. Erneut versuchen oder abbrechen; es wurde keine Datei gespeichert.",
  "view.retry.retry": "Noch einmal versuchen",
  "view.retry.cancel": "Abbrechen",
  "desktop.done.title": "Bild gespeichert",
  "desktop.done.size": "{width} × {height} Pixel",
  "desktop.done.saved": "Im gewählten Ordner gespeichert.",
  "desktop.done.open": "Bild öffnen",
  "desktop.done.reveal": "Im Ordner anzeigen",
  "desktop.done.openError":
    "Das Bild konnte nicht geöffnet werden. Prüfen Sie, ob ein Standard-Bildbetrachter installiert ist.",
  "desktop.done.folderError":
    "Der Ordner konnte nicht geöffnet werden. Prüfen Sie, ob ein Dateimanager installiert ist.",
  "desktop.done.missingError": "Das gespeicherte Bild oder der Ordner ist nicht mehr vorhanden.",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Verstanden",
  "view.modal.closeDialog": "Dialog schließen",
  "view.modal.closeTitle": "Schließen",
  // Desktop-app guidance modal.
  "view.desktop.title": "Dezoomify Desktop-App",
  "view.desktop.download.windows": "Windows-Installationsprogramm · x64 (MSI)",
  "view.desktop.download.macos": "macOS-Installationsprogramm · Apple Silicon (DMG)",
  "view.desktop.download.linux": "Linux-Installationsprogramm · x64 (DEB)",
  "view.desktop.step1":
    "Laden Sie oben das Installationsprogramm für Ihr System herunter und installieren Sie es.",
  "view.desktop.subtitle": "Große Bilder direkt auf Ihrem Computer speichern",
  "view.desktop.whyTitle": "Warum die Desktop-App verwenden?",
  "view.desktop.why1Title": "Größere Bilder herunterladen:",
  "view.desktop.why1Body":
    "Speichern Sie Bilder, die die Größenlimits Ihres Browsers überschreiten. Die App kann die Datei während des Downloads aufbauen, ohne das ganze Bild im Arbeitsspeicher zu halten. Sehr große Bilder können dennoch ein anderes Dateiformat oder eine kleinere Größe erfordern.",
  "view.desktop.why2Title": "Die eigene Verbindung nutzen:",
  "view.desktop.why2Body":
    "Die App lädt Bildinformationen und jedes Bildstück über Ihre Internetverbindung direkt von der Quellwebsite. Das kann helfen, wenn eine Website den gemeinsam genutzten Server von Dezoomify blockiert.",
  "view.desktop.why3Title": "Das Dateiformat wählen:",
  "view.desktop.why3Body":
    "Speichern Sie als JPEG, PNG, TIFF oder in anderen Formaten zum Betrachten, Bearbeiten oder Archivieren. Wählen Sie den Ordner für Ihre Bilder.",
  "view.desktop.howTitle": "So verwenden Sie sie",
  "view.desktop.step2":
    "Öffnen Sie Dezoomify und fügen Sie die Adresse der Seite oder des zoombaren Bildes ein.",
  "view.desktop.step3":
    "Wählen Sie einen Ordner, ein Dateiformat und eine Bildgröße, und starten Sie den Download.",
  "view.desktop.cliTitle": "Automatisierung gesucht? Nutzen Sie Dezoomify CLI",
  "view.desktop.cliDesc":
    "Mit der Kommandozeilenversion können Sie Bilder per Skript herunterladen oder eine Liste von Adressen verarbeiten.",
  "view.desktop.cliLink": "CLI von GitHub Releases laden",
  // Browser-extension guidance modal.
  "view.ext.title": "Dezoomify Browser-Erweiterung",
  "view.ext.subtitle":
    "Zoombare Bilder von der geöffneten Seite speichern, auch auf Websites, auf denen Sie angemeldet sind",
  "view.ext.availableOn": "Verfügbar auf",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Warum die Browser-Erweiterung verwenden?",
  "view.ext.why1Title": "Bestehende Anmeldung nutzen:",
  "view.ext.why1Body":
    "Laden Sie Bilder herunter, auf die Sie nach der Anmeldung bei einer Bibliothek, einem Museum oder Archiv zugreifen können. Benötigt die Erweiterung Zugriff auf eine andere Website, bittet sie um Ihre Erlaubnis.",
  "view.ext.why2Title": "Die Suche nach der Bildadresse sparen:",
  "view.ext.why2Body":
    "Klicken Sie in der Browser-Symbolleiste auf Dezoomify, um das Bild im Bildbetrachter der Seite zu finden. Der Download startet in einem neuen Tab. Die Größenlimits des Browsers gelten weiterhin.",
  "view.ext.why3Title": "Startet auf Ihren Wunsch:",
  "view.ext.why3Body":
    "Die Erweiterung prüft die Seite erst, wenn Sie auf ihre Schaltfläche klicken. Sie beobachtet Ihr Surfen nicht im Hintergrund.",
  "view.ext.howTitle": "So verwenden Sie sie in 3 Schritten",
  "view.ext.step1":
    "Installieren Sie die Erweiterung aus dem Chrome Web Store oder von Firefox Browser Add-ons.",
  "view.ext.step2":
    "Öffnen Sie die Seite mit Ihrem Bild, melden Sie sich bei Bedarf an und zoomen Sie einmal hinein, damit das Bild geladen wird.",
  "view.ext.step3":
    "Klicken Sie in der Browser-Symbolleiste auf Dezoomify. Erlauben Sie den Zugriff, falls Sie gefragt werden, und lassen Sie den Download-Tab bis zum Ende des Speicherns geöffnet.",
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
  "view.step.downloading": "Bildstücke werden heruntergeladen…",
  "view.step.saving": "Endbild wird zusammengesetzt…",
  "view.step.contactingDetail": "Quellwebsite wird kontaktiert…",
  // Live job section.
  "view.job.techDetails": "Technische Details und Protokolle",
  "view.job.manyImages": "{count} Bilder",
  "view.job.paused": "Pausiert",
  "view.job.retryingTiles": "{count} Bildstücke werden erneut heruntergeladen…",
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
    "Findet das Bild auf der geöffneten Seite, auch wenn Sie dort angemeldet sind.",
  "view.display.deskTitle": "Anleitung zur Desktop-App",
  "view.display.deskDescClean":
    "Direkt von der Quellwebsite herunterladen, wenn Ihr Browser nur eine Vorschau anzeigen kann.",
  "view.display.startOver": "Von vorn beginnen",
  "view.resolution.title": "Bild mit geringerer Auflösung",
  "view.resolution.sizes": "Bildgröße: {selected} Pixel. Verfügbares Maximum: {maximum} Pixel.",
  "view.resolution.download": "Volle Auflösung mit der Desktop-App erhalten",
  "view.desktop.handoffTitle": "Dieses Bild in der Desktop-App herunterladen",
  "view.desktop.handoffInstall":
    "Wählen Sie das Installationsprogramm für Ihr Betriebssystem und öffnen Sie Dezoomify.",
  "view.desktop.handoffPaste": "Fügen Sie diese Adresse in die Desktop-App ein:",
  "view.desktop.handoffCopy": "Adresse kopieren",
  "view.desktop.handoffCopied": "Adresse kopiert. Fügen Sie sie in die Desktop-App ein.",
  "view.desktop.handoffCopyFailed":
    "Kopieren fehlgeschlagen. Markieren Sie die Adresse oben und kopieren Sie sie manuell.",
  "view.desktop.handoffStart":
    "Wählen Sie im Menü Größe die Option Volle Auflösung und starten Sie den Download.",
  "view.desktop.handoffAccess":
    "Die Desktop-App kann Ihre Anmeldung im Browser nicht nutzen. Versuchen Sie für Bilder, die eine Anmeldung erfordern, die Browser-Erweiterung.",
  "view.desktop.handoffUnavailable":
    "Für diesen Download gibt es keine Bildadresse zum Kopieren. Kopieren Sie die Adresse der ursprünglichen Seite und versuchen Sie es damit in der Desktop-App.",
  // Completion section.
  "view.done.ready": "Ihr Bild ist bereit.",
  "view.done.readyTitle": "Bereit zum Speichern",
  "view.done.saveNow": "Bild jetzt speichern",
  "view.done.another": "Weiteres Bild dezoomifizieren",
  "view.done.guidance":
    "Laden Sie Ihr Bild mit der Speichern-Schaltfläche herunter. Farben können leicht abweichen, da Browser-Downloads das ursprüngliche Farbprofil nicht erhalten. Nutzen Sie die Desktop-App für Formate, die Farbprofile bewahren.",
  "view.done.summary": "{width} × {height} Pixel ({mime})",
  "view.done.fallback":
    "Ein auf dieser Seite verfügbares Bild wurde gespeichert. Falls es nicht das gewünschte Bild ist, können Sie dies über die technischen Details unten melden.",
  "view.display.guidance":
    "Ihr Browser kann dieses Bild anzeigen, aber die Quellwebsite erlaubt ihm nicht, eine herunterladbare Datei zu erstellen. Versuchen Sie es zum Speichern mit der Desktop-App oder Browser-Erweiterung.",
  // Failure section.
  "view.fail.title": "Bild konnte nicht dezoomifiziert werden",
  "view.fail.deskDescLimits":
    "Größere Bilder speichern oder die eigene Verbindung nutzen, wenn eine Website unseren Server blockiert.",
  "view.fail.helpTitle": "Hilfe bei der Bildsuche",
  "view.fail.helpDesc":
    "So finden Sie die Bildadresse auf Museums- und Archivseiten, und was Sie versuchen können, wenn nichts gefunden wird.",
  "view.fail.reportBug": "Fehler auf GitHub melden",
  "view.fail.reportBugDesc":
    "Erstellen Sie einen GitHub-Bericht mit den Diagnosedaten dieses Versuchs.",
  "view.fail.retry": "Erneut versuchen",
  "view.fail.canvasAllocation":
    "Dieses Bild ist zu groß für diesen Browser-Tab. Versuchen Sie es mit der Desktop-App, um ein größeres Bild zu speichern.",
  "view.fail.canvasContext":
    "Ihr Browser konnte ein Bild dieser Größe nicht vorbereiten. Versuchen Sie es mit der Desktop-App oder schließen Sie andere Tabs und versuchen Sie es erneut.",
  // Cancelled section.
  "view.cancel.title": "Speichern abgebrochen",
  "view.cancel.message": "Das Speichern des Bildes wurde gestoppt.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} von {total} Bildstücken",
  "view.job.pixelCounts": "{current} von {total}",
  "view.job.pixels": "{count} px",
  "view.job.megapixels": "{count} Mpx",
  "view.job.gigapixels": "{count} Gpx",
  "view.job.preparation": "{percent}% der Pixel vorbereitet. Das Bild wird fertig gespeichert.",
  "view.job.countsActive": "{current} von {total} Bildstücken · {active} in Arbeit",
  // Recent pictures, including unsuccessful attempts.
  "view.history.title": "Letzte Bilder",
  "view.history.empty": "Noch keine Bilder. Gestartete Bilder erscheinen hier.",
  "view.history.localOnly": "Nur auf diesem Gerät behalten.",
  "view.history.clear": "Verlauf löschen",
  "view.history.source": "Quelle",
  "view.history.time": "Beginn",
  "view.history.size": "Größe (px)",
  "view.history.result": "Ergebnis",
  "view.history.remove": "Entfernen",
  "view.history.removeImage": "{image} aus den letzten Bildern entfernen",
  "view.history.status.started": "Gestartet",
  "view.history.status.completed": "Abgeschlossen",
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
    "Speichern Sie zoombare Bilder aus Museen, Bibliotheken, Archiven und anderen Websites. Fügen Sie zum Starten die Adresse der Seite ein, die Ihr Bild zeigt.",
  "view.input.placeholder": "Seiten- oder Bildadresse einfügen",
  "view.input.aria": "Adresse der Webseite mit dem zoombaren Bild",
  "view.input.start": "Bild finden",
  // Rate-limit explainers (see failure.ts plainMessageFor).
  "view.fail.rateProxy":
    "Die Quellwebsite begrenzt Downloads von unserem Server. Warten Sie einige Minuten oder versuchen Sie es mit der Desktop-App oder Browser-Erweiterung über Ihre eigene Internetverbindung.",
  "view.fail.rateDirect":
    "Die Quellwebsite begrenzt Downloads von Ihrer eigenen Verbindung. Warten Sie einige Minuten und versuchen Sie es erneut. Desktop-App und Erweiterung nutzen dieselbe Verbindung und helfen möglicherweise nicht.",
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
    "Die Quellwebsite hat einen Dateityp zurückgegeben, den Dezoomify hier nicht lesen kann.",
  "view.fail.hintRedirect":
    "Die Website hat so umgeleitet, wie es die Website nicht nachvollziehen kann.",
  "view.fail.proxyBudget":
    "Diese Datei ist zu groß für den Abruf durch unseren Server. Versuchen Sie es mit der Desktop-App, um sie direkt herunterzuladen.",
  "view.fail.proxyFetch":
    "Unser Server konnte diese Adresse nicht abrufen. Versuchen Sie es in Kürze erneut oder nutzen Sie die Desktop-App, um sich direkt mit der Quellwebsite zu verbinden.",
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
    "Dieses Bild benötigt mehr Arbeitsspeicher als verfügbar ({dims},{need}; Grenze {limit}). Speichern Sie eine kleinere Fassung mit Max. Breite (CLI: --max-width), oder wählen Sie einen Kachelordner. Von {host}.",
  "desktop.tile.failed":
    "Eine Kachel von {host} konnte nicht geladen werden. Prüfen Sie das Quellbild und versuchen Sie es erneut.",
  "view.discovery.none":
    "Unter dieser Adresse wurde kein zoombares Bild gefunden. Versuchen Sie eine Seite mit Betrachter oder die Browsererweiterung.",
  "view.discovery.noneExtension":
    "Auf dieser Seite wurde kein zoombares Bild gefunden. Melden Sie einen Fehler mit den Diagnosedaten oder folgen Sie der Anleitung, um die Bildadresse zu finden.",
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
  "desktop.invoke.retry": "Die Auswahl zum erneuten Versuch wurde abgelehnt.",
  "desktop.cancel.note":
    "Speichern abgebrochen. Aufgeräumt, und jede unfertige Datei wurde entfernt.",
  "desktop.copy.diagnostics": "Diagnose kopieren",
  "desktop.copy.copied": "Kopiert!",
  "desktop.panel.jobActions": "Desktop-Auftragsaktionen",
  "desktop.settings.reset": "Einstellungen zurücksetzen",
  "desktop.quick.info": "Weitere Informationen",
  "desktop.quick.auto": "Automatisch",
  "desktop.quick.compression": "Kompression",
  "desktop.quick.compressionInfo":
    "Höhere Werte zielen auf kleinere Dateien. Jedes Format bestimmt die Wirkung auf Bildqualität und Kodierzeit.",
  "desktop.quick.compressionUnavailable":
    "Für dieses Format ist die Kompression nicht einstellbar.",
  "desktop.quick.compressionWarning":
    "Starker Detailverlust: Diese Kompression kann Text und feine Details unlesbar machen.",
  "desktop.quick.sizeEstimate": "Bis etwa {size}",
  "desktop.quick.folderInfo": "Wählen Sie den Speicherort für heruntergeladene Bilder.",
  "desktop.quick.formatInfo":
    "Wählen Sie ein Ausgabeformat. Automatisch wählt ein für das Bild geeignetes Format.",
  "desktop.quick.sizeInfo":
    "Jede Schätzung setzt ein Bild mit der maximalen Breite und Höhe der Vorgabe voraus. Eine kleinere Quelle oder ein anderes Seitenverhältnis kann eine viel kleinere Datei ergeben. Die Schätzungen interpolieren Messwerte für Format und Kompression, berücksichtigen zusätzliche Pyramidenstufen, addieren 10 % Reserve und runden auf zwei signifikante Stellen mit passender Größeneinheit auf. Es sind grobe Richtwerte, keine garantierten Datei- oder Speichergrenzen; Details, Transparenz und Metadaten beeinflussen das Ergebnis. Automatisch nimmt ein undurchsichtiges JPEG an; Transparenz verwendet PNG. Vorgaben wählen eine Quellstufe ohne Skalierung. Passt keine, wird die kleinste verwendet; sie kann das gewählte Maximum überschreiten. Volle und eigene Größen hängen von der Quelle ab.",
  "desktop.quick.maxWidth": "Max. Breite",
  "desktop.quick.maxHeight": "Max. Höhe",
  "desktop.quick.original": "Original",
  "desktop.quick.userDefined": "Benutzerdefiniert",
  "desktop.quick.estimatedSize": "Schätzung bei Maximalgröße ({format})",
  "desktop.quick.networkInfo":
    "Schnell nutzt bis zu 16 gleichzeitige Anfragen ohne Drosselung. Ausgewogen startet bis zu 5 Anfragen pro Sekunde, Schonend bis zu 2. Langsameres Tempo kann ausgelasteten Servern helfen.",
  "desktop.quick.source": "Quellabhängig",
  "desktop.quick.exact": "Individuell",
  "desktop.quick.upTo": "Bis zu {size}K",
  "desktop.quick.hint.adaptive": "adaptiv",
  "desktop.quick.hint.lossless": "verlustfrei",
  "desktop.quick.hint.compressed": "komprimiert",
  "desktop.quick.hint.advancedCompression": "fortgeschrittene Kompression",
  "desktop.quick.hint.archival": "Archivierung",
  "desktop.quick.hint.zoomable": "zoombar",
  "desktop.quick.hint.tiled": "gekachelt",
  "desktop.quick.format.auto":
    "JPEG für undurchsichtige Bilder bis {maxSide} Pixel pro Seite; PNG bei Transparenz oder größeren Bildern. Die Kompression gilt auch für Automatisch.",
  "desktop.quick.format.png":
    "Verlustfreie Pixel und Transparenz; größere Dateien, für die Bearbeitung geeignet.",
  "desktop.quick.format.jpeg":
    "Kleinere verlustbehaftete Dateien. Keine Transparenz; höchstens {maxSide} Pixel pro Seite. Die Kompression lässt sich im Menü Größe einstellen.",
  "desktop.quick.format.tiff": "Verlustfreie Ausgabe zur Archivierung und Bearbeitung.",
  "desktop.quick.format.webp": "Verlustfrei komprimierte Ausgabe bis {maxSide} Pixel pro Seite.",
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
  "desktop.output.codecLimit":
    "Dieses Bild ({dims}) ist zu groß für {format}, das höchstens {maxSide} Pixel pro Seite erlaubt. Speichern Sie es als PNG. Quelle: {host}.",
  "desktop.quick.format.avif":
    "Fortgeschrittene Kompression mit Transparenz. Verlustbehaftete Ausgabe, begrenzt auf {maxSide} Pixel pro Seite. Die Kompression lässt sich im Menü Größe einstellen. Benötigt das gesamte Bild im Arbeitsspeicher und erhält eingebettete Farbprofile nicht. Auch die niedrigste Kompression ist verlustbehaftet.",
  "desktop.quick.format.generic": "Das Bild als {format} speichern.",
  "desktop.advanced.dimensions": "Eigene Abmessungen",
  "desktop.advanced.dimensionsDesc":
    "Einen Wert leer lassen, um das Originalverhältnis zu bewahren.",
  "desktop.advanced.width": "Breite",
  "desktop.advanced.height": "Höhe",
  "desktop.advanced.retries": "Versuche",
  "desktop.advanced.retriesDesc":
    "Automatische Versuche, bevor ein weiterer Versuch angeboten wird.",
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
