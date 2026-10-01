//! Generated asynchronous bindings for the shared algorithm and injected Host.
#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used)]

#[cfg(target_arch = "wasm32")]
mod bindings {
    use dezoomify::model::*;
    use serde::{de::DeserializeOwned, Serialize};
    use wasm_bindgen::prelude::*;

    fn boundary_error(detail: impl std::fmt::Display) -> Error {
        Error::BindingInvalidValue {
            failure: detail.to_string().into(),
        }
    }

    fn encode(value: &impl Serialize) -> Result<JsValue, Error> {
        value
            .serialize(
                &serde_wasm_bindgen::Serializer::new()
                    .serialize_maps_as_objects(true)
                    .serialize_bytes_as_arrays(false),
            )
            .map_err(boundary_error)
    }

    fn decode<T: DeserializeOwned>(value: JsValue) -> Result<T, Error> {
        serde_wasm_bindgen::from_value(value).map_err(boundary_error)
    }

    fn rejected(value: JsValue) -> Error {
        decode(value.clone())
            .unwrap_or_else(|_| boundary_error(format!("Host rejected: {value:?}")))
    }

    fn js_error(error: Error) -> JsValue {
        encode(&error).unwrap_or_else(|_| JsValue::from_str(&error.to_string()))
    }

    macro_rules! ts_type {
        (u32) => {
            "number"
        };
        (()) => {
            "void"
        };
        (String) => {
            "string"
        };
        ($name:ident) => {
            stringify!($name)
        };
    }

    // The member list also declares the native Rust trait.
    macro_rules! bind_host {
        (async { $( $method:ident => $js:ident( $( $arg:ident: $ty:tt ),* ) -> $out:tt; )* }
         sync { $( $notify:ident($value:ident: $value_ty:tt); )* } settle();) => {
            #[wasm_bindgen]
            extern "C" {
                #[wasm_bindgen(typescript_type = "Host")]
                pub type JsHost;
                $(
                    #[wasm_bindgen(method, catch, js_name = $js)]
                    async fn $method(this: &JsHost, $( $arg: JsValue ),*) -> Result<JsValue, JsValue>;
                )*
                $(
                    #[wasm_bindgen(method, catch)]
                    fn $notify(this: &JsHost, $value: JsValue) -> Result<(), JsValue>;
                )*
                #[wasm_bindgen(method, catch, js_name = settle)]
                async fn js_settle(this: &JsHost) -> Result<JsValue, JsValue>;
            }

            impl dezoomify::Host for JsHost {
                $(
                    async fn $method(&self, $( $arg: $ty ),*) -> Result<$out, Error> {
                        let value = JsHost::$method(self, $( encode(&$arg)? ),*)
                            .await.map_err(rejected)?;
                        decode(value)
                    }
                )*
                $(
                    fn $notify(&self, $value: $value_ty) {
                        if let Ok(value) = encode(&$value) {
                            let _ = JsHost::$notify(self, value);
                        }
                    }
                )*
                async fn settle(&self) {
                    let _ = self.js_settle().await;
                }
            }

            #[wasm_bindgen(typescript_custom_section)]
            const HOST: &str = concat!(
                "export interface Host {\n",
                $( stringify!($js), "(", $(stringify!($arg), ": ", ts_type!($ty), ",",)*
                   "): Promise<", ts_type!($out), ">;\n", )*
                $( stringify!($notify), "(", stringify!($value), ": ", ts_type!($value_ty), "): void;\n", )*
                "settle(): Promise<void>;\n}\n",
            );
        }
    }
    dezoomify::host_members!(bind_host);

    #[wasm_bindgen(skip_typescript)]
    pub async fn dezoomify(
        inputs: JsValue,
        options: JsValue,
        host: JsHost,
    ) -> Result<JsValue, JsValue> {
        let arguments = decode::<Vec<JobInput>>(inputs)
            .and_then(|inputs| decode(options).map(|options| (inputs, options)));
        let result = match arguments {
            Ok((inputs, options)) => dezoomify::dezoomify(inputs, options, &host).await,
            Err(error) => {
                dezoomify::Host::settle(&host).await;
                Err(error)
            }
        };
        result.and_then(|output| encode(&output)).map_err(js_error)
    }

    #[wasm_bindgen(js_name = applyProcessing, skip_typescript)]
    pub fn apply_processing(recipe: JsValue, bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        decode::<ProcessingRecipe>(recipe)
            .map_err(js_error)?
            .apply(bytes.to_vec())
            .map_err(|error| {
                js_error(Error::ProcessingFailed {
                    failure: error.to_string().into(),
                })
            })
    }

    #[wasm_bindgen(typescript_custom_section)]
    const FUNCTIONS: &str = "
export function dezoomify(inputs: JobInput[], options: Options, host: Host): Promise<Output>;
export function applyProcessing(recipe: ProcessingRecipe, bytes: Uint8Array): Uint8Array;
";
}
