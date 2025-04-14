import { Request, Response } from "express";
import util from "util";
import Booking from "../infrastructure/schemas/Booking";
import stripe from "../infrastructure/stripe";
import Hotel from "../infrastructure/schemas/Hotel";

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET as string;
const FRONTEND_URL = process.env.FRONTEND_URL as string;

async function fulfillCheckout(sessionId: string) {
  console.log("Fulfilling Checkout Session:", sessionId);

  const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items"],
  });

  console.log(
    util.inspect(checkoutSession, false, null, true)
  );

  const bookingId = checkoutSession.metadata?.bookingId;
  if (!bookingId) {
    console.warn("Missing bookingId in session metadata");
    return;
  }

  const booking = await Booking.findById(bookingId);
  if (!booking) throw new Error("Booking not found");

  // Prevent re-processing
  if (booking.paymentStatus === "PAID") {
    console.log(`Booking ${bookingId} already marked as PAID. Skipping...`);
    return;
  }

  if (checkoutSession.payment_status === "paid") {
    await Booking.findByIdAndUpdate(bookingId, {
      paymentStatus: "PAID",
    });
    console.log(`Booking ${bookingId} marked as PAID.`);
  } else {
    console.warn(`Checkout session ${sessionId} not paid yet.`);
  }
}

export const handleWebhook = async (req: Request, res: Response) => {
  const payload = req.body;
  const sig = req.headers["stripe-signature"] as string;

  try {
    const event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);

    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object as any;
      await fulfillCheckout(session.id);
    }

    res.status(200).send();
  } catch (err: any) {
    console.error("Webhook Error:", err.message || err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
};

export const createCheckoutSession = async (req: Request, res: Response) => {
  try {
    const { bookingId } = req.body;
    console.log("Creating checkout session for bookingId:", bookingId);

    const booking = await Booking.findById(bookingId);
    if (!booking) throw new Error("Booking not found");

    const hotel = await Hotel.findById(booking.hotelId);
    if (!hotel) throw new Error("Hotel not found");

    const checkIn = new Date(booking.checkIn);
    const checkOut = new Date(booking.checkOut);
    const numberOfNights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));

    if (!hotel.stripePriceId) {
      throw new Error("Stripe price ID is missing for this hotel");
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      line_items: [
        {
          price: hotel.stripePriceId,
          quantity: numberOfNights,
        },
      ],
      mode: "payment",
      return_url: `${FRONTEND_URL}/booking/complete?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        bookingId: booking._id.toString(),
      },
    });

    if (!session.client_secret) {
      throw new Error("Stripe did not return a client secret");
    }

    res.status(200).json({ clientSecret: session.client_secret });
  } catch (error: any) {
    console.error("Error creating checkout session:", error.message || error);
    res.status(500).json({
      message: "Failed to create checkout session",
      error: error.message || "Unknown error",
    });
  }
};

export const retrieveSessionStatus = async (req: Request, res: Response) => {
  try {
    const sessionId = req.query.session_id as string;

    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    const bookingId = checkoutSession.metadata?.bookingId;

    if (!bookingId) throw new Error("Missing bookingId in session metadata");

    const booking = await Booking.findById(bookingId);
    if (!booking) throw new Error("Booking not found");

    const hotel = await Hotel.findById(booking.hotelId);
    if (!hotel) throw new Error("Hotel not found");

    res.status(200).json({
      bookingId: booking._id,
      booking,
      hotel,
      status: checkoutSession.status,
      customer_email: checkoutSession.customer_details?.email,
      paymentStatus: booking.paymentStatus,
    });
  } catch (error: any) {
    console.error("Error retrieving session status:", error.message || error);
    res.status(500).json({
      message: "Failed to retrieve session status",
      error: error.message || "Unknown error",
    });
  }
};
