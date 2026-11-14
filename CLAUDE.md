# CopyBoard — Claude için notlar

## Commit kuralları

- Commit mesajına `Co-Authored-By` ya da başka bir trailer ekleme; mesaj yalnız başlık ve gövdeden oluşur.
- Commit ve etiketlerde tek kimlik `Nurullah YAYAN <nurullah.yayan@gmail.com>`. Geçmişe başka bir e-posta girmemeli.
- `.claude/settings.json` bunları Claude'un commit'lerinde zorluyor (`attribution.commit` boş; `GIT_AUTHOR_*` ve `GIT_COMMITTER_*` sabit). Elle atılan commit'ler ise klonun git ayarını kullanır: bu klonda `git config user.email` farklıysa repo-local olarak düzelt ve kullanıcıya söyle.
