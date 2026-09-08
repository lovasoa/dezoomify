// German message dictionary for the shared UI.
//
// Mirrors `../i18n.ts` key for key: every English key has exactly one German
// entry with identical `{placeholders}`. Missing keys fall back to English at
// lookup time, so this table must never drop a key when English grows.
// Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub Releases",
// "GPL", "PNG", "JPEG", "URL", "CLI", "FAQ") stay literal.
//
// Erasable-syntax-only TypeScript (plain object, no enums) so
// `scripts/sync-web-js.mjs` can mirror it to `locales/de.js` for browsers.

export const de = {
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Verstanden",
  "view.modal.closeDialog": "Dialog schliessen",
  "view.modal.closeTitle": "Schliessen",
  // Desktop-app guidance modal.
  "view.desktop.title": "Dezoomify Desktop-App",
  "view.desktop.subtitle":
    "Leistungsstarke native Anwendung fuer gigapixelgrosse Museumsbilder und lokale Scans",
  "view.desktop.noInstaller":
    "Noch gibt es kein Installationsprogramm. Ein kuenftiges Programm fuer {platform} erscheint auf",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.whyTitle": "Warum die Desktop-App verwenden?",
  "view.desktop.why1Title": "Bewaltigt grossere Kunstwerke:",
  "view.desktop.why1Body":
    "Ein Browser-Tab kann nur eine begrenzte Bildmenge halten. Die Desktop-App setzt das Bild im Speicher zusammen (bis zu ihrer Canvas-Grenze von 8 GiB, mit entsprechend freiem Speicher) und schreibt das fertige Ergebnis auf die Festplatte.",
  "view.desktop.why2Title": "Speichert das fertige Bild:",
  "view.desktop.why2Body": "Jeder Auftrag wird in genau eine Ausgabedatei auf Ihrem Rechner gespeichert. Sie konnen mehrere Auftrage einreihen; sie werden nacheinander gespeichert.",
  "view.desktop.why3Title": "Wenn die Website nicht fertig wird:",
  "view.desktop.why3Body":
    "Die Website bricht den Auftrag mit einem Fehler ab und verweist fuer das vollstandige Bild auf die Desktop-App.",
  "view.desktop.howTitle": "So verwenden Sie sie",
  "view.desktop.step1":
    "Noch gibt es kein Installationsprogramm; ein kuenftiges Programm fuer {platform} erscheint auf unserer GitHub-Releases-Seite.",
  "view.desktop.step2": "Starten Sie Dezoomify und fuegen Sie die Adresse Ihres zoombaren Bildes oder Manifests ein.",
  "view.desktop.step3":
    "Wahlen Sie die gewuenschte Auflosung und den Zielordner, um das vollstandige zusammengesetzte Bild zu speichern.",
  "view.desktop.cliTitle": "Automatisierung gesucht? Nutzen Sie Dezoomify CLI",
  "view.desktop.cliDesc":
    "Das CLI ermoglicht kopfloses, skriptfahiges Speichern einzelner Auftrage, ideal fuer automatisierte Ablaufe und Server ohne Anzeige.",
  "view.desktop.cliLink": "CLI von GitHub Releases laden",
  // Browser-extension guidance modal.
  "view.ext.title": "Dezoomify Browser-Erweiterung",
  "view.ext.subtitle":
    "Automatische Viewer-Erkennung fuer passwortgeschuetzte digitale Archive und komplexe Seiten",
  "view.ext.availableOn": "Verfuegbar auf",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxVersion": "Firefox-Version",
  "view.ext.firefoxSoon": "In Vorbereitung",
  "view.ext.whyTitle": "Warum die Browser-Erweiterung verwenden?",
  "view.ext.why1Title": "Angemeldete Seiten:",
  "view.ext.why1Body":
    "Wahrend Sie ein zoombares Bild betrachten, findet sie automatisch das Bild hinter dem Viewer, auch auf Seiten, auf denen Sie angemeldet sind, etwa Bibliotheksportale, Museumsabos und wissenschaftliche Archive.",
  "view.ext.why2Title": "Einfach zu bedienen:",
  "view.ext.why2Body":
    "Druecken Sie die Dezoomify-Schaltflache in der Symbolleiste und wahlen Sie das zu speichernde Bild, oder senden Sie den Auftrag an die Desktop-App, wenn das Bild sehr gross ist.",
  "view.ext.why3Title": "Privat:",
  "view.ext.why3Body":
    "Sie betrachtet nur die Seite, auf die Sie gezeigt haben, und erst nachdem Sie die Schaltflache gedrueckt haben. Sie beobachtet Ihr Surfen nicht im Hintergrund.",
  "view.ext.howTitle": "So verwenden Sie sie in 3 Schritten",
  "view.ext.step1":
    "Installieren Sie die Erweiterung aus dem Chrome Web Store. Die Firefox-Version ist in Vorbereitung.",
  "view.ext.step2":
    "Offnen Sie die Museums- oder Bibliotheksseite mit Ihrem Kunstwerk und melden Sie sich bei Bedarf an.",
  "view.ext.step3":
    "Klicken Sie auf das Dezoomify-Symbol in der Symbolleiste, um das vollaufgeloste Bild automatisch zu erkennen und zu speichern!",
  // Idle input section.
  "view.idle.intro": "ermoglicht das Speichern",
  "view.idle.zoomable": "zoombarer Bilder",
  "view.idle.zoomableTitle": "Grosse Bilder, in denen man innerhalb einer Webseite navigieren kann.",
  "view.idle.enterThe": "Geben Sie die",
  "view.idle.urlAbbr": "URL",
  "view.idle.urlTitle": "Uniform Resource Locator, die Adresse einer Webseite",
  "view.idle.body":
    "eines solchen Bildes in das Textfeld unten ein. Das Bild wird in maximaler Auflosung gespeichert. Danach klicken Sie mit der rechten Maustaste auf das Bild und wahlen „Speichern unter“, um es als PNG auf Ihrem Rechner zu sichern. Falls es nicht klappt, lesen Sie unsere",
  "view.idle.troubleLink": "Anleitung zur Fehlersuche",
  "view.idle.moreInfo": "Fuer weitere Informationen lesen Sie unsere",
  "view.idle.projectLink": "Projektseite",
  "view.idle.license1": "Dieses Skript erscheint unter der",
  "view.idle.gplLink": "GPL",
  "view.idle.sourceLink": "Quellcode ansehen",
  "view.idle.termsLink": "Wir lehnen jede Verantwortung fuer eine rechtswidrige Nutzung dieser Software ab",
  "view.idle.urlPlaceholder": "URL der Webseite mit Ihrem Bild",
  "view.idle.urlAria": "URL der Webseite mit Ihrem zoombaren Bild",
  "view.idle.clearTitle": "Eingabe loschen",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Zoombares Bild wird gesucht…",
  "view.step.choosingImage": "Bild gefunden; bestes wird gewahlt…",
  "view.step.choosingLevel": "Hochste Auflosung wird gewahlt…",
  "view.step.preflighting": "Bildgrosse wird geprueft…",
  "view.step.downloading": "Bildkacheln werden gespeichert…",
  "view.step.saving": "Endbild wird zusammengesetzt…",
  "view.step.working": "Arbeitet…",
  // Live job section.
  "view.job.workingOn": "Arbeitet an",
  "view.job.cancel": "Abbrechen",
  "view.job.change": "Andern",
  "view.job.techDetails": "Technische Details und Protokolle",
  "view.job.oneImage": "1 Bild",
  "view.job.manyImages": "{count} Bilder",
  "view.job.autoChoiceFull": "{noun} gefunden, grosste passende wird gespeichert ({width}×{height}, {tiles} Kacheln).",
  "view.job.autoChoiceDims": "{noun} gefunden, grosste passende wird gespeichert ({width}×{height}).",
  "view.job.autoChoiceTiles": "{noun} gefunden, grosste passende wird gespeichert ({tiles} Kacheln).",
  "view.job.autoChoiceBare": "{noun} gefunden, grosste passende wird gespeichert.",
  "view.job.stalled":
    "Lauft noch, {host} antwortet langsam. Sie konnen warten oder abbrechen und es spater erneut versuchen.",
  // Display-only section.
  "view.display.title": "Vorschau wird gezeigt, noch nicht gespeichert",
  "view.display.shownPlain": "Unten gezeigt, ohne zu speichern.",
  "view.display.shownPrefix": "Unten gezeigt, ohne zu speichern.",
  "view.display.openDesktop": "In der Desktop-App offnen",
  // One-click desktop handoff (todo 5.5): the button names the origin and the
  // summary names scope/recipient/job memory-only, mirroring the extension
  // consent pattern (origins, cookie names, job). The desktop app confirms
  // again before any effect; declining there does nothing.
  "view.handoff.send": "An die Desktop-App senden",
  "view.handoff.sendOrigin": "An die Desktop-App senden ({origin})",
  "view.handoff.summary":
    "Sendet {origin} an die Desktop-App. Keine Anmeldedaten reisen mit; nur ein Auftrag, nur im Speicher.",
  "view.handoff.localNote":
    "Lokale Dateien bleiben auf diesem Rechner. Offnen Sie die Desktop-App und wahlen Sie dort die Datei; nichts wird gesendet.",
  "view.display.waysTitle": "Wege, dieses Kunstwerk zu speichern",
  "view.display.extTitle": "Anleitung zur Browser-Erweiterung",
  "view.display.extDesc":
    "Fuer Seiten mit Anmeldung oder Sitzungs-Cookies. Erkennt Viewer auf aktiven Seiten automatisch.",
  "view.display.deskTitle": "Anleitung zur Desktop-App",
  "view.display.deskDescClean": "Fuer ein sauberes Speichern in voller Grosse, wenn der Browser das Bild nur zeigen kann.",
  "view.display.startOver": "Von vorn beginnen",
  // Completion section.
  "view.done.ready": "Ihr Bild ist bereit.",
  "view.done.savedDisk": "Auf der Festplatte gespeichert",
  "view.done.readyTitle": "Bereit zum Speichern",
  "view.done.saveNow": "Bild jetzt speichern",
  "view.done.another": "Weiteres Bild dezoomifizieren",
  // Already-saved completion (ViewContext.savedOutput): the host wrote the
  // output before rendering (for example the extension blob-anchor save), so
  // completion reads as saved with the file name and offers no second-click
  // save button. Absent keeps the website ready plus save-now path.
  "view.done.savedFile": "Gespeichert",
  "view.done.gaps": "Mit Luecken gespeichert",
  "view.done.savedFull": "{name} gespeichert ({w}x{h}).",
  "view.done.savedPartial":
    "{name} gespeichert ({w}x{h}, {done} von {total} Kacheln; {failed} Kachel(n) fehlen).",
  // Gap map behind a kept partial: the missing-tile ledger renders inline
  // with the completion summary, so a partial save never reads as silent
  // gaps. `shown` lists the first ledger ids, `rest` names the overflow.
  "view.done.gapMap": "Fehlende Kacheln ({failed} von {total}): {shown}{rest}.",
  "view.done.gapMapMore": ", und {n} weitere",
  // Failure section.
  "view.fail.fallback": "Dezoomify konnte das zoombare Bild unter dieser Adresse nicht finden oder speichern.",
  "view.fail.title": "Bild konnte nicht dezoomifiziert werden",
  "view.fail.deskDescLimits":
    "Fuer Bilder, die die Speichergrenzen des Browsers sprengen, innerhalb einer Canvas-Grenze von 8 GiB (mit entsprechend freiem Speicher). Wird nativ auf Ihrem Rechner verarbeitet.",
  "view.fail.helpTitle": "Hilfe und Adresssuche",
  "view.fail.helpDesc":
    "So finden Sie die Bildadresse auf Museums- und Archivseiten, und was Sie versuchen konnen, wenn nichts gefunden wird.",
  "view.fail.techDetails": "Technische Fehlerdetails und Fehlermeldung",
  "view.fail.reportBug": "Fehler auf GitHub melden",
  "view.fail.retry": "Erneut versuchen",
  // Cancelled section.
  "view.cancel.title": "Speichern abgebrochen",
  "view.cancel.message": "Das Speichern des Bildes wurde gestoppt.",
  // Generic fallback for unknown phases (debug surface; status codes stay raw).
  "view.generic.status": "Status:",
  "view.generic.reset": "Zuruecksetzen",
  // Image and level picker dialogs.
  "view.pick.imageTitle": "Bild wahlen",
  "view.pick.imageSub":
    "Das empfohlene Bild ist bereits gewahlt. Druecken Sie Auswahl verwenden, um mit einem Klick fortzufahren.",
  "view.pick.imageGroup": "Auf dieser Seite gefundene Bilder",
  "view.pick.autoImage": "Grosste passende verwenden",
  "view.pick.autoImageMeta": "Empfohlen, ein Klick",
  "view.pick.cancel": "Abbrechen",
  "view.pick.useSelected": "Auswahl verwenden",
  "view.pick.levelTitle": "Auflosung wahlen",
  "view.pick.levelSub": "An Bildschirm anpassen ist bereits gewahlt. Druecken Sie Auswahl verwenden, um mit einem Klick fortzufahren.",
  "view.pick.levelGroup": "Auflosungen fuer das gewahlte Bild",
  "view.pick.fitScreen": "An Bildschirm anpassen",
  "view.pick.fitScreenMeta": "Hochste passende Auflosung, empfohlen",
  "view.pick.fullRes": "Volle Auflosung",
  "view.pick.fullResMeta": "Grosste verfuegbare",
  "view.pick.levelName": "Stufe {index}",
  "view.pick.loadingSize": "Grosse wird beim Laden gezeigt",
  "view.pick.fits": "passt in den Browser",
  "view.pick.tooLarge": "zu gross, braucht die Desktop-App",
  "view.pick.tilesMeta": ", {tiles} Kacheln",
  // Job section picker and share chrome.
  "view.job.shareTitle": "Kopiert die Seitenadresse fuer diesen Auftrag, nicht die Bilddatei selbst",
  "view.job.shareLink": "Link zu diesem Auftrag kopieren",
  "view.job.chooseImage": "{noun} gefunden. Wahlen Sie, welches Bild gespeichert wird{suffix}",
  "view.job.chooseLevel": "Bild gewahlt. Wahlen Sie eine Auflosung{suffix}",
  "view.job.chooseBtn": "Wahlen",
  "view.job.chooseAria": "Aus den angebotenen Optionen wahlen",
  "view.job.changeAria": "Ueber die automatische Wahl",
  "view.job.pickHint": "Die empfohlene Wahl ist bereits getroffen. Druecken Sie Wahlen, um sie zu pruefen.",
  "view.job.autoHintChoose":
    "Die Website speichert automatisch das grosste Bild. Um ein anderes Bild zu wahlen, nutzen Sie Wahlen wahrend der Auswahl oder die Desktop-App.",
  "view.job.countsFull": "{current} von {total} Kacheln",
  "view.job.countsElapsed": "{current} von {total} Kacheln · {elapsed} vergangen",
  "view.job.elapsedOnly": "{elapsed} vergangen",
  // Recent-jobs history (todo 5.2): local-only ledger.
  "view.history.title": "Zuletzt gespeicherte Bilder",
  "view.history.empty": "Noch keine gespeicherten Bilder. Gespeicherte Bilder erscheinen hier.",
  "view.history.localOnly": "Nur auf diesem Gerat behalten.",
  "view.history.open": "Erneut offnen",
  "view.history.clear": "Verlauf loschen",
  "view.history.dims": "{w} mal {h} Pixel",
  "view.input.eyebrow": "Zoombare Bilder speichern",
  "view.input.title": "Dezoomify",
  "view.input.description":
    "Dezoomify speichert zoombare Bilder. Fuegen Sie unten die URL eines Bildbetrachters, Manifests oder einer Kachel-Adresse ein. Dezoomify findet das Bild und speichert die hoechste Aufloesung, die in Ihren Browser passt. Wenn es fertig ist, speichern Sie das Bild mit der Schaltflaeche auf Ihrem Computer.",
  "view.input.placeholder": "Adresse eines Bildbetrachters oder Manifests einfuegen",
  "view.input.aria": "Adresse der Webseite mit dem zoombaren Bild",
  "view.input.start": "Bild finden",
  // Failure "What happened" explainer.
  "view.fail.whatHappened": "Was geschehen ist",
  "view.fail.rateProxy":
    "Die Website, die dieses Bild hostet, begrenzt, wie viele Seiten unser Server bei ihr anfordern darf, und diese Grenze wurde gerade erreicht, daher konnte die Seite nicht geoffnet werden. Die Browser-Erweiterung und die Desktop-App laden ueber Ihre eigene Verbindung statt ueber unseren Server und sind von dieser Grenze nicht betroffen.",
  "view.fail.rateDirect":
    "Die Website, die dieses Bild hostet, erhalt gerade zu viele Anfragen von Ihrer eigenen Verbindung. Wenige Minuten Wartezeit klaren dies meist, und Erweiterung oder Desktop-App sehen bis dahin dasselbe Besetztzeichen.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid": "Bitte geben Sie eine gueltige Webadresse ein, die mit http:// oder https:// beginnt",
  "desktop.url.notWebPage":
    "Diese Adresse sieht nicht wie eine Webseitenadresse aus. Geben Sie eine Adresse ein, die mit http:// oder https:// beginnt.",
  "desktop.settings.unusable":
    "Diese Download-Einstellungen konnen nicht verwendet werden. Passen Sie die markierten Einstellungen an und versuchen Sie es erneut.",
  "desktop.settings.invalidSubmit": "Diese Download-Einstellungen sind ungueltig. Passen Sie sie an und versuchen Sie es erneut.",
  "desktop.output.deniedPick": "Das Speicherziel wurde nicht angenommen. Wahlen Sie eine andere Datei, um fortzufahren.",
  "desktop.output.deniedFallback": "Das Speicherziel wurde verweigert.",
  "desktop.proto.incompatible":
    "Diese App-Version kann dieses Bild von {host} nicht offnen. Aktualisieren Sie die App und versuchen Sie es erneut.",
  "desktop.handoff.rejected":
    "Dieser Link kann von {host} aus nicht geoffnet werden. Versuchen Sie eine andere Adresse ohne Anmeldedaten.",
  "desktop.handoff.acceptedDetail":
    "Dieses Bild kann an eine andere App uebergeben werden. Sie sind bereits in der nativen App und konnen hier fortfahren.",
  "desktop.handoff.rejectedDetail":
    "Dieses Bild kann nicht an eine andere App uebergeben werden. Fahren Sie hier fort oder versuchen Sie ein anderes Bild.",
  "desktop.output.exists":
    "Am Speicherziel von {host} existiert bereits eine Datei. Wahlen Sie eine andere Datei oder bestatigen Sie das Ueberschreiben, um fortzufahren.",
  "desktop.output.destDenied":
    "Das Speicherziel wurde von {host} aus nicht angenommen. Wahlen Sie eine andere Datei, um fortzufahren.",
  "desktop.job.gone": "Dieser Auftrag ist von {host} aus nicht mehr aktiv. Beginnen Sie erneut mit einer frischen Adresse.",
  "desktop.msg.thisPicture": "dieses Bild",
  "desktop.msg.dimsPixels": "{a} mal {b} Pixel",
  "desktop.msg.needAbout": " Es braucht etwa {need} Speicher",
  "desktop.output.canvasLimit":
    "Dieses Bild ist zu gross, um es auf diesem Rechner zusammenzusetzen ({dims},{need} bei 4 Byte je Pixel, Grenze {limit}). Speichern Sie eine kleinere Fassung mit Max. Breite (CLI: --max-width). Hinweis: JPEG erlaubt hochstens {jpegMax} Pixel je Seite; behalten Sie PNG fuer grossere Bilder. Von {host}.",
  "desktop.output.jpegLimit":
    "Dieses Bild ({dims}) ist zu gross fuer JPEG, das hochstens {jpegMax} Pixel je Seite erlaubt. Speichern Sie es stattdessen als PNG. Von {host}.",
  "desktop.tile.partialDiscarded":
    "Das Teilbild wurde verworfen, sodass keine Datei blieb. Versuchen Sie es von {host} aus mit stabiler Verbindung erneut.",
  "desktop.tile.partialChoice":
    "Einige Teile dieses Bildes von {host} konnten nicht gespeichert werden. Versuchen Sie die fehlenden Teile erneut oder behalten Sie das Teilbild mit leeren Flachen.",
  "desktop.discovery.none":
    "Kein zoombares Bild unter dieser Adresse von {host} gefunden. Versuchen Sie eine andere Seite oder pruefen Sie die Adresse.",
  "desktop.plan.none":
    "Dieses Bild hat von {host} aus keine speicherbare Grosse. Versuchen Sie ein anderes Bild oder eine kleinere Max. Breite.",
  "desktop.transport.stalled": "Speichern stockt beim Kontakt mit {host}. Pruefen Sie Ihre Verbindung und versuchen Sie es erneut.",
  "desktop.output.writeFail":
    "Dieses Bild von {host} konnte nicht geschrieben werden. Wahlen Sie ein anderes Speicherziel und versuchen Sie es erneut.",
  "desktop.job.cancelledMsg": "Das Speichern des Bildes wurde gestoppt. Jede unfertige Datei wurde entfernt.",
  "desktop.start.failed": "Das Speichern dieses Bildes von {host} konnte nicht gestartet werden. Versuchen Sie es erneut.",
  "desktop.choice.failed": "Diese Wahl wurde nicht angenommen. Versuchen Sie es erneut.",
  "desktop.save.generic": "Dieses Bild von {host} konnte nicht gespeichert werden. Versuchen Sie es mit einer anderen Adresse erneut.",
  "desktop.internal.error":
    "Etwas Unerwartetes hat dieses Speichern von {host} gestoppt. Versuchen Sie es erneut und kopieren Sie die Diagnose, falls es erneut geschieht.",
  "desktop.save.fallback": "Dieses Bild von {host} konnte nicht gespeichert werden. Versuchen Sie es erneut.",
  "desktop.job.failedFallback": "Der Auftrag ist fehlgeschlagen.",
  "desktop.invoke.startFallback": "Der Auftrag konnte nicht gestartet werden.",
  "desktop.invoke.choiceImage": "Die Bildwahl wurde abgelehnt.",
  "desktop.invoke.choiceLevel": "Die Auflosungswahl wurde abgelehnt.",
  "desktop.invoke.retry": "Die Wiederholungsanfrage wurde abgelehnt.",
  "desktop.invoke.partial": "Die Teilbildwahl wurde abgelehnt.",
  "desktop.invoke.destination": "Das Speicherziel konnte nicht angefragt werden.",
  "desktop.step.chooseWhere": "Wahlen Sie, wo gespeichert wird…",
  "desktop.step.chooseWhereDetail": "Das Speicherziel braucht Aufmerksamkeit, bevor der Auftrag fortfahren kann.",
  "desktop.step.pickOutput": "Wahlen Sie die Ausgabedatei, um fortzufahren.",
  "desktop.step.partialTitle": "Einige Kacheln konnten nicht gespeichert werden…",
  "desktop.step.partialDetail": "Wahlen Sie, ob Sie das Teilbild behalten, verwerfen oder erneut versuchen.",
  "desktop.step.displayPreview": "Nur Anzeige…",
  "desktop.step.displayDetail": "Dieses Bild kann hier nur betrachtet werden.",
  "desktop.step.cleanupDetail": "Raeumt auf… unfertige Datei wird entfernt…",
  "desktop.step.cleaningShort": "Raeumt auf…",
  "desktop.step.encodingNative": "Wird in der nativen App kodiert",
  "desktop.step.encodingPartial": "Teilbild wird in der nativen App kodiert",
  "desktop.step.discardingPartial": "Teilbild wird verworfen",
  "desktop.step.retrying": "Wird erneut versucht",
  "desktop.step.appAutoDetail": "Die App speichert automatisch das erste Bild; keine Auswahl wird angeboten.",
  "desktop.step.foundFits": "{noun} gefunden, grosste passende wird gespeichert…",
  "desktop.step.tilesAtFull": "{current} von {total} Kacheln in voller Auflosung",
  "desktop.step.savedDims": "{width} mal {height} Pixel gespeichert",
  "desktop.step.partialDims": "Teilbild {width} mal {height} Pixel; {summary}",
  "desktop.step.partialSaved": "Teilbild gespeichert; {summary}",
  "desktop.step.savedWord": "Gespeichert",
  "desktop.step.contacting": "{host} wird kontaktiert…",
  "desktop.link.title": "Eine andere App mochte ein Bild in Dezoomify offnen.",
  "desktop.link.source": "Quelle: {url}",
  "desktop.link.prov": "Herkunft: dezoomify://-Link (v{version})",
  "desktop.link.provHint": "Herkunft: dezoomify://-Link (v{version}) · {hint}",
  "desktop.link.note": "Nichts lauft, bis Sie bestatigen. Ablehnen bewirkt nichts.",
  "desktop.link.dismiss": "Verwerfen",
  "desktop.link.open": "Bild offnen",
  "desktop.rec.partialTitle": "Einige Kacheln konnten nicht gespeichert werden",
  "desktop.rec.partialDesc":
    "Ein Teil des Bildes fehlt. {summary} Behalten Sie das Teilbild (leere Flachen bleiben leer), verwerfen Sie es oder versuchen Sie die fehlenden Kacheln erneut.",
  "desktop.rec.missing": "Fehlende Kacheln: {shown}{rest}.",
  "desktop.rec.more": " und {n} weitere",
  "desktop.rec.destTitle": "Speicherziel braucht Aufmerksamkeit",
  "desktop.rec.destDesc":
    "Das Speicherziel wurde nicht angenommen. Wahlen Sie eine Ausgabedatei, versuchen Sie es erneut oder nutzen Sie eine andere App.",
  "desktop.rec.chooseTitle": "Wahlen Sie, wo gespeichert wird",
  "desktop.rec.chooseDesc": "Wahlen Sie die Ausgabedatei, um dieses Bild weiter zu speichern.",
  "desktop.rec.keep": "Teilbild behalten",
  "desktop.rec.discard": "Teilbild verwerfen",
  "desktop.rec.retryTiles": "Fehlende Kacheln erneut versuchen",
  "desktop.rec.chooseOutput": "Ausgabe wahlen…",
  "desktop.rec.tryAgain": "Erneut versuchen",
  "desktop.rec.useOther": "Andere App verwenden",
  "desktop.rec.missingSome": "Einige Kacheln konnten nicht gespeichert werden.",
  "desktop.rec.missingCount": "{count} Kachel{plural} konnten nicht gespeichert werden.",
  "desktop.rec.missingList": "{n} Kachel{plural} fehlen: {shown}{rest}.",
  "desktop.done.partialTitle": "Teilbild gespeichert",
  "desktop.done.partialDesc":
    "Diese Datei ist als Teilbild markiert: {summary} Fehlende Flachen bleiben leer. So unterscheidet sie sich von einem vollstandigen Speichern.",
  "desktop.cancel.note": "Speichern abgebrochen. Aufgeraeumt, und jede unfertige Datei wurde entfernt.",
  "desktop.copy.diagnostics": "Diagnose kopieren",
  "desktop.copy.copied": "Kopiert!",
  // Multi-job queue panel (desktop integration queue, todo 5.3). Jobs save
  // one at a time in the order they were added; a failed job never stops the
  // rest. Only redacted origins appear here, never full addresses.
  "desktop.queue.title": "Warteschlange",
  "desktop.queue.statusQueued": "Wartet",
  "desktop.queue.statusActive": "Lauft",
  "desktop.queue.statusDone": "Fertig",
  "desktop.queue.statusFailed": "Fehlgeschlagen",
  "desktop.queue.statusCancelled": "Abgebrochen",
  "desktop.queue.cancel": "Abbrechen",
  "desktop.queue.cancelAll": "Alle abbrechen",
  "desktop.queue.retry": "Erneut versuchen",
  "desktop.queue.summary": "{succeeded} fertig, {failed} fehlgeschlagen, {total} gesamt",
  "desktop.queue.progress": "{current} von {total} Kacheln",
  "desktop.queue.unknownOrigin": "der Server",
  "desktop.panel.outputFormat": "Ausgabeformat",
  "desktop.panel.jobActions": "Desktop-Auftragsaktionen",
  "desktop.help.title": "Hilfe und Info",
  "desktop.help.help": "Hilfe",
  "desktop.help.desktopGuide": "Desktop-Anleitung",
  "desktop.help.troubleshooting": "Fehlersuche",
  "desktop.help.faq": "FAQ",
  "desktop.help.privacy": "Datenschutz",
  "desktop.help.terms": "Bedingungen",
  "desktop.help.donate": "Spenden",
  "desktop.settings.title": "Anpassen",
  "desktop.settings.desc":
    "Minimale Download-Einstellungen. Auf diesem Gerat gespeichert und fuer den nachsten Auftrag verwendet. Kopfzeilen gehen nur an die Bildquelle und werden nie protokolliert.",
  "desktop.settings.fileGroup": "Datei",
  "desktop.settings.imageGroup": "Bild",
  "desktop.settings.networkGroup": "Netzwerk und Wiederaufnahme",
  "desktop.settings.outputDir": "Ausgabeordner (optional)",
  "desktop.settings.compression": "Kompression 0-100 (Standard 5)",
  "desktop.settings.maxWidth": "Max. Breite in px (optional)",
  "desktop.settings.maxHeight": "Max. Hohe in px (optional)",
  "desktop.settings.retries": "Versuche 0-100 (Standard 3, 0 = keine)",
  "desktop.settings.cacheDir": "Cache-Ordner (optional, Fortsetzungs-Cache)",
  "desktop.settings.emptyLargest": "leer = grosste",
  "desktop.settings.browse": "Durchsuchen…",
  "desktop.settings.browseOutput": "Ausgabeordner wahlen",
  "desktop.settings.browseCache": "Cache-Ordner wahlen",
  "desktop.settings.headersAdv": "Erweitert: Anfragekopfzeilen (vertrauenswuerdig)",
  "desktop.settings.headersLabel": "Anfragekopfzeilen, eine je Zeile als Name: Wert (optional, vertrauenswuerdig)",
  "desktop.settings.reset": "Einstellungen zuruecksetzen",
  // Extension modal user copy. The modal
  // imports this table through its vendored `vendor/i18n.js` codegen
  // mirror (see `scripts/sync-web-js.mjs`) and renders through the same
  // `t(key, vars)` shape; log and diagnostics lines stay literal English and
  // never use these keys. `test/ui-i18n.test.mjs` fails when the page renders
  // a key outside this table.
  "page.step.scanning": "Seite wird gelesen…",
  "page.step.finding": "Zoombares Bild wird gesucht ({done}/{total})…",
  "page.step.choosing": "Hochste Auflosung wird gewahlt…",
  "page.step.saving": "Bildkacheln werden gespeichert…",
  "page.step.assembling": "Endbild wird zusammengesetzt…",
  "page.step.done": "Fertig",
  "page.step.cancelled": "Abgebrochen",
  "page.step.cancelling": "Wird abgebrochen…",
  "page.step.displaying": "Bild wird angezeigt…",
  "page.tabs.scan": "{label} lesen",
  "page.tabs.hint":
    "Offnen Sie eine Seite mit einem zoombaren Bild und klicken Sie dann auf die Dezoomify-Schaltflache, um diesen Tab zu lesen.",
  "page.handoff.sendOrigin": "An die Desktop-App senden ({origin})",
  "page.handoff.stay": "In der Erweiterung bleiben",
  "page.handoff.send": "An die Desktop-App senden",
  "page.handoff.title": "An die Desktop-App senden?",
  "page.handoff.host": "Rechner: {host}",
  "page.handoff.origins": "Herkunft: {list}",
  "page.handoff.originsNone": "Herkunft: (keine)",
  "page.handoff.cookies": "Cookies: {list}",
  "page.handoff.cookiesNone": "Cookies: (keine)",
  "page.handoff.job": "Auftrag: {id}",
  "page.handoff.note": "Nichts wird gesendet, bis Sie bestatigen. Ablehnen belasst den Auftrag in der Erweiterung.",
  "page.ui.techDetails": "Technische Details und Protokolle",
} as const;
