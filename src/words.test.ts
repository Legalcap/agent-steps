import { describe, expect, it } from "vitest";
import { looksSecret, namesFinalAction, namesSearch, namesSecret } from "./words.ts";

describe("screen words", () => {
  it.each<[string, string[]]>([
    ["en", ["Send", "Send Message", "Delete Forever", "Buy now", "Pay", "Place your order", "Post", "Publish", "Submit", "Transfer", "Don’t Save", "Empty Trash", "Move to Trash", "paperplane.fill"]],
    ["de", ["Senden", "Löschen", "Jetzt kaufen", "Zahlungspflichtig bestellen", "Bezahlen", "Veröffentlichen", "Absenden", "Überweisen", "Nicht sichern"]],
    ["es", ["Enviar", "Eliminar", "Comprar ahora", "Pagar", "Realizar pedido", "Publicar", "Transferir", "No guardar"]],
    ["fr", ["Envoyer", "Supprimer", "Acheter", "Payer", "Passer la commande", "Publier", "Soumettre", "S’abonner", "Ne pas enregistrer"]],
    ["it", ["Invia", "Elimina", "Acquista", "Paga", "Effettua l’ordine", "Pubblica", "Bonifico", "Non salvare"]],
    ["pt-br", ["Enviar", "Excluir", "Apagar", "Comprar", "Pagar", "Fazer pedido", "Publicar", "Não Salvar"]],
    ["pl", ["Wyślij", "Usuń", "Kup teraz", "Zapłać", "Złóż zamówienie", "Opublikuj", "Przelej", "Nie zachowuj"]],
    ["ru", ["Отправить", "Удалить", "Купить", "Оплатить", "Оформить заказ", "Опубликовать", "Перевести", "Не сохранять"]],
    ["uk", ["Надіслати", "Видалити", "Купити", "Оплатити", "Оформити замовлення", "Опублікувати", "Переказати", "Не зберігати"]],
    ["tr", ["Gönder", "Sil", "SİL", "KALDIR", "Satın al", "Öde", "Sipariş ver", "Yayınla", "Kaydetme"]],
    ["vi", ["Gửi", "Xóa", "Xoá", "Mua ngay", "Thanh toán", "Đặt hàng", "Đăng", "Xác nhận", "Không lưu"]],
    ["hi", ["भेजें", "हटाएँ", "हटाएं", "खरीदें", "भुगतान करें", "ऑर्डर करें", "प्रकाशित करें", "सबमिट करें", "सहेजें नहीं"]],
    ["ko", ["보내기", "전송", "삭제", "구매하기", "결제", "주문하기", "게시", "제출", "송금", "이체", "발행", "휴지통 비우기", "저장 안 함"]],
    ["ja", ["送信", "削除", "購入する", "支払う", "注文を確定する", "投稿", "振込", "保存しない", "ゴミ箱を空にする"]],
    ["zh", ["发送", "删除", "立即购买", "支付", "提交订单", "发布", "转账", "不存储", "清倒废纸篓"]],
    ["zh-tw", ["傳送", "刪除", "購買", "付款", "下單", "發佈", "轉帳", "不要儲存", "清空垃圾桶"]],
  ])("name a final action in %s", (_, labels) => {
    for (const label of labels) expect(namesFinalAction(label), label).toBe(true);
  });

  it("leave everyday labels alone, in many languages", () => {
    for (const label of ["Inbox", "Sent", "Sender", "Deleted Items", "Drafts", "Open", "Save", "Cancel", "OK", "Settings", "PayPal", "Gesendet", "Speichern",
      "Envoyés", "Enregistrer", "Enviados", "Guardar", "Inviati", "Salva", "Wysłane", "Отправленные", "Сохранить", "Надіслані", "Gönderilenler", "Kaydet",
      "Lưu", "Đăng nhập", "सहेजें", "保存", "受信", "收件箱", "收件匣", "받은 편지함", "보낸 편지함", "저장", "취소", "확인", "열기", "설정", "", undefined]) {
      expect(namesFinalAction(label), String(label)).toBe(false);
    }
  });

  it("know a secret field in each language", () => {
    for (const label of ["Password", "Enter your PIN", "One‑time code", "Passwort", "Contraseña", "Mot de passe", "Codice PIN", "Senha", "Hasło", "Пароль", "Пін-код",
      "Şifre", "Mật khẩu", "पासवर्ड", "비밀번호", "암호", "인증번호", "パスワード", "暗証番号", "密码", "验证码", "密碼"]) {
      expect(namesSecret(label), label).toBe(true);
    }
    for (const label of ["Username", "Email", "Search", "Pinned", "Shopping list", "Benutzername", "Имя пользователя", "Notes", ""]) {
      expect(namesSecret(label), label).toBe(false);
    }
  });

  it("name the final actions of code, money and accounts too", () => {
    for (const label of ["Merge pull request", "Deploy to production", "Terminate instance", "Revoke access", "Refund customer", "Cancel order", "Deactivate account",
      "Sign out of all devices", "Log out", "Block user", "Cerrar sesión", "Reembolsar", "Abmelden", "Se déconnecter", "退款", "ログアウト"]) {
      expect(namesFinalAction(label), label).toBe(true);
    }
    for (const label of ["Accept", "Continue", "Next", "Cancel", "Sign in", "Log in", "Reports", "Deployments", "Merged", "Blocked"]) expect(namesFinalAction(label), label).toBe(false);
  });

  it("know a search box, and text that looks like a key", () => {
    for (const label of ["Search", "Search products", "Buscar", "Suche", "Rechercher", "搜索", "検索", "Filter"]) expect(namesSearch(label), label).toBe(true);
    for (const label of ["Message", "Full name", "Comment", ""]) expect(namesSearch(label), label).toBe(false);
    for (const text of ["sk-live-51Habcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123", "AKIAIOSFODNN7EXAMPLE", "d41d8cd98f00b204e9800998ecf8427e", "aB3dE6gH9jK2mN5pQ8sT1vW4xY7z"]) {
      expect(looksSecret(text), text).toBe(true);
    }
    for (const text of ["wireless headphones", "Calle Mayor 5", "ana.garcia@example.com", "https://example.com/a/very/long/path/Abc123Def456", "Sony WH-1000XM5", "{api_key}", "28013"]) {
      expect(looksSecret(text), text).toBe(false);
    }
  });

  it("read labels in any case, Unicode form or spacing", () => {
    for (const label of ["DELETE", "  send  ", "ｓｅｎｄ", "Delete…", "Send—now"]) expect(namesFinalAction(label), label).toBe(true);
  });
});
