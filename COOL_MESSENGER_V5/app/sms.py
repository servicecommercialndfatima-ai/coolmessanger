import logging

from .config import TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, SMS_ENABLED

log = logging.getLogger("cool_messenger.sms")


def send_sms(to_number: str, body: str) -> tuple[bool, str]:
    if not SMS_ENABLED:
        return False, "Passerelle SMS non configurée."
    try:
        from twilio.rest import Client
        msg = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN).messages.create(body=body, from_=TWILIO_FROM_NUMBER, to=to_number)
        return True, msg.sid
    except Exception:
        # Le détail reste dans les journaux du serveur : il peut contenir des informations du compte.
        log.exception("Échec d'envoi du SMS")
        return False, "Le fournisseur SMS a refusé l'envoi. Vérifiez le numéro et réessayez."
